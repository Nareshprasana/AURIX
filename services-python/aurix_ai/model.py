"""Small numerical market model: SGD logistic regression with a streaming scaler.

Real parameter updates via sklearn `partial_fit` (epoch = one pass, no shuffle
by default so resume is exactly reproducible). Checkpoints are immutable npz
files holding params + scaler state + epoch/step + config + versions + seed.
"""

from __future__ import annotations

import json
import os

import numpy as np

from .errors import fail


class StreamingStandardScaler:
    """Mean/var via Chan parallel update; partial_fit on TRAIN only."""

    def __init__(self):
        self.mean_: np.ndarray | None = None
        self.var_: np.ndarray | None = None
        self.n_: int = 0

    def partial_fit(self, X: np.ndarray) -> "StreamingStandardScaler":
        X = np.asarray(X, dtype=float)
        if X.ndim != 2:
            raise fail("INVALID_FEATURE", "features must be 2-D")
        if not np.all(np.isfinite(X)):
            raise fail("INVALID_FEATURE", "non-finite feature values")
        b_mean = X.mean(axis=0)
        b_var = X.var(axis=0)
        b_n = X.shape[0]
        if self.n_ == 0:
            self.mean_, self.var_, self.n_ = b_mean, b_var, b_n
        else:
            total = self.n_ + b_n
            delta = b_mean - self.mean_
            self.mean_ = self.mean_ + delta * b_n / total
            self.var_ = (self.n_ * self.var_ + b_n * b_var
                         + self.n_ * b_n / total * delta ** 2) / total
            self.n_ = total
        return self

    def transform(self, X: np.ndarray) -> np.ndarray:
        if self.mean_ is None:
            raise fail("INVALID_CONFIG", "scaler not fitted")
        scale = np.sqrt(np.maximum(self.var_, 1e-12))
        return (np.asarray(X, dtype=float) - self.mean_) / scale


class MarketMLP:
    """SGDClassifier(log_loss) wrapper with explicit epoch/step accounting."""

    def __init__(self, alpha: float = 0.0001, random_state: int = 7):
        from sklearn.linear_model import SGDClassifier
        self.clf = SGDClassifier(loss="log_loss", alpha=alpha, learning_rate="optimal",
                                 random_state=random_state, shuffle=False, tol=None)
        self.scaler = StreamingStandardScaler()
        self.classes_ = np.array([0, 1])
        self.epoch = 0
        self.step = 0
        self.alpha = alpha
        self.random_state = random_state

    def fit_scaler(self, X_train: np.ndarray) -> None:
        self.scaler.partial_fit(X_train)

    def partial_epoch(self, X: np.ndarray, y: np.ndarray) -> float:
        """One real optimization pass. Returns mean log-loss on the batch."""
        from sklearn.metrics import log_loss
        Xs = self.scaler.transform(X)
        self.clf.partial_fit(Xs, y, classes=self.classes_)
        self.epoch += 1
        self.step += 1
        proba = self.clf.predict_proba(Xs)
        return float(log_loss(y, proba, labels=[0, 1]))

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        return self.clf.predict_proba(self.scaler.transform(X))

    def state_dict(self) -> dict:
        return {
            "coef": np.asarray(self.clf.coef_),
            "intercept": np.asarray(self.clf.intercept_),
            "scaler_mean": np.asarray(self.scaler.mean_),
            "scaler_var": np.asarray(self.scaler.var_),
            "scaler_n": np.asarray([self.scaler.n_]),
            "epoch": np.asarray([self.epoch]),
            "step": np.asarray([self.step]),
            "t_": np.asarray([float(getattr(self.clf, "t_", 0.0))]),
        }

    def load_state_dict(self, d: dict) -> None:
        # Prime the optimizer structures with one partial_fit on zeros, then
        # overwrite with checkpointed params (exact resume incl. schedule t_).
        n_feat = d["coef"].shape[1]
        self.clf.partial_fit(np.zeros((2, n_feat)), np.array([0, 1]), classes=self.classes_)
        self.clf.coef_ = np.asarray(d["coef"])
        self.clf.intercept_ = np.asarray(d["intercept"])
        if hasattr(self.clf, "t_"):
            try:
                self.clf.t_ = float(np.asarray(d["t_"]).ravel()[0])
            except Exception:
                pass
        self.scaler.mean_ = np.asarray(d["scaler_mean"])
        self.scaler.var_ = np.asarray(d["scaler_var"])
        self.scaler.n_ = int(np.asarray(d["scaler_n"]).ravel()[0])
        self.epoch = int(np.asarray(d["epoch"]).ravel()[0])
        self.step = int(np.asarray(d["step"]).ravel()[0])


class LogRegLBFGS:
    """Batch LogisticRegression (lbfgs) fitted to convergence in one shot.

    Same scaler discipline (train-only), same checkpoint/artifact schema as
    MarketMLP, plus solver metadata. Deterministic given data+seed; resume is
    an exact refit, so checkpoints stay truthful. Use when the SGD path
    cannot converge within budget (see training-proof loss 5.8 vs 0.69).
    """

    def __init__(self, alpha: float = 0.0001, random_state: int = 7,
                 max_iter: int = 1000):
        from sklearn.linear_model import LogisticRegression
        c = 1.0 / max(alpha, 1e-12)
        self.clf = LogisticRegression(C=c, solver="lbfgs", max_iter=max_iter,
                                      random_state=random_state)
        self.scaler = StreamingStandardScaler()
        self.classes_ = np.array([0, 1])
        self.epoch = 0
        self.step = 0
        self.alpha = alpha
        self.random_state = random_state
        self.max_iter = max_iter
        self.converged = False

    def fit_scaler(self, X_train: np.ndarray) -> None:
        self.scaler.partial_fit(X_train)

    def fit(self, X: np.ndarray, y: np.ndarray) -> float:
        """Fit to convergence. Returns mean train log-loss."""
        from sklearn.metrics import log_loss
        import warnings
        from sklearn.exceptions import ConvergenceWarning
        Xs = self.scaler.transform(X)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", ConvergenceWarning)
            self.clf.fit(Xs, y)
        self.epoch += 1
        self.step += 1
        used = int(getattr(self.clf, "n_iter_", [self.max_iter])[0])
        self.converged = used < self.max_iter
        proba = self.clf.predict_proba(Xs)
        return float(log_loss(y, proba, labels=[0, 1]))

    def partial_epoch(self, X: np.ndarray, y: np.ndarray) -> float:
        return self.fit(X, y)

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        return self.clf.predict_proba(self.scaler.transform(X))

    def state_dict(self) -> dict:
        return {
            "coef": np.asarray(self.clf.coef_),
            "intercept": np.asarray(self.clf.intercept_),
            "scaler_mean": np.asarray(self.scaler.mean_),
            "scaler_var": np.asarray(self.scaler.var_),
            "scaler_n": np.asarray([self.scaler.n_]),
            "epoch": np.asarray([self.epoch]),
            "step": np.asarray([self.step]),
            "t_": np.asarray([0.0]),
            "solver": np.asarray(["lbfgs"]),
            "converged": np.asarray([self.converged]),
        }

    def load_state_dict(self, d: dict) -> None:
        n_feat = np.asarray(d["coef"]).shape[1]
        self.clf.fit(np.zeros((2, n_feat)), np.array([0, 1]))
        self.clf.coef_ = np.asarray(d["coef"])
        self.clf.intercept_ = np.asarray(d["intercept"])
        self.scaler.mean_ = np.asarray(d["scaler_mean"])
        self.scaler.var_ = np.asarray(d["scaler_var"])
        self.scaler.n_ = int(np.asarray(d["scaler_n"]).ravel()[0])
        self.epoch = int(np.asarray(d["epoch"]).ravel()[0])
        self.step = int(np.asarray(d["step"]).ravel()[0])
        try:
            self.converged = bool(np.asarray(d["converged"]).ravel()[0])
        except Exception:
            self.converged = False


def make_model(model_type: str, alpha: float = 0.0001, random_state: int = 7,
               max_iter: int = 1000):
    """Solver factory. Unknown types fail closed (no silent fallback)."""
    if model_type == "sgd-logloss":
        return MarketMLP(alpha=alpha, random_state=random_state)
    if model_type == "logreg-lbfgs":
        return LogRegLBFGS(alpha=alpha, random_state=random_state, max_iter=max_iter)
    raise fail("INVALID_CONFIG", f"unsupported model_type: {model_type}")


def save_checkpoint(path: str, model, meta: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path):
        raise fail("INVALID_CONFIG", f"checkpoint exists (immutable): {path}")
    np.savez(path, **model.state_dict(),
             meta_json=np.asarray([json.dumps(meta, sort_keys=True)]))


def load_checkpoint(path: str, model: MarketMLP) -> dict:
    if not os.path.exists(path):
        raise fail("CHECKPOINT_CORRUPT", f"missing checkpoint: {path}")
    try:
        z = np.load(path, allow_pickle=False)
        model.load_state_dict({k: z[k] for k in z.files if k != "meta_json"})
        return json.loads(str(z["meta_json"][0]))
    except Exception as e:
        raise fail("CHECKPOINT_CORRUPT", f"{path}: {e}")
