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


def _check_torch():
    try:
        import torch
        import torch.nn as nn
        return torch, nn
    except Exception as e:
        raise fail("DEPENDENCY_MISSING", f"PyTorch is required for TorchMLP: {e}")


def _get_activation(act_name: str):
    torch, nn = _check_torch()
    acts = {
        "relu": nn.ReLU,
        "tanh": nn.Tanh,
        "gelu": nn.GELU,
        "leaky_relu": nn.LeakyReLU,
        "silu": nn.SiLU,
    }
    name = str(act_name).lower().strip()
    if name not in acts:
        raise fail("INVALID_CONFIG", f"unsupported activation: {act_name}")
    return acts[name]()


class TorchMLP:
    """Small CPU-compatible PyTorch Multilayer Perceptron for market signals.

    Features:
      - Fully-connected feed-forward network with configurable architecture.
      - Fits StreamingStandardScaler exclusively on TRAIN partition (no lookahead/leakage).
      - Strict reproducible seeding via torch.manual_seed.
      - Exact resume equality from immutable npz checkpoints without pickle dependency.
      - Standard binary classification predict_proba interface [[1-p, p], ...].
    """

    def __init__(self, in_features: int = 8, hidden_dims=(32, 16),
                 activation: str = "relu", lr: float = 0.001,
                 weight_decay: float = 0.0001, batch_size: int = 32,
                 random_state: int = 7, **kwargs):
        _check_torch()
        self.in_features = int(in_features)
        if isinstance(hidden_dims, str):
            self.hidden_dims = tuple(int(x.strip()) for x in hidden_dims.split(",") if x.strip())
        elif isinstance(hidden_dims, int):
            self.hidden_dims = (hidden_dims,)
        else:
            self.hidden_dims = tuple(int(x) for x in hidden_dims)
        if not self.hidden_dims or any(h <= 0 for h in self.hidden_dims):
            raise fail("INVALID_CONFIG", f"invalid hidden_dims: {hidden_dims}")

        self.activation_name = str(activation).lower().strip()
        self.lr = float(kwargs.get("learning_rate", lr))
        self.weight_decay = float(kwargs.get("alpha", weight_decay))
        self.batch_size = int(batch_size)
        self.random_state = int(kwargs.get("seed", random_state))
        self.scaler = StreamingStandardScaler()
        self.classes_ = np.array([0, 1])
        self.epoch = 0
        self.step = 0
        self.converged = False

        self._init_network()

    def _init_network(self) -> None:
        torch, nn = _check_torch()
        torch.manual_seed(self.random_state)
        layers = []
        prev = self.in_features
        for h in self.hidden_dims:
            layers.append(nn.Linear(prev, h))
            layers.append(_get_activation(self.activation_name))
            prev = h
        layers.append(nn.Linear(prev, 1))
        self.net = nn.Sequential(*layers)
        self.optimizer = torch.optim.Adam(
            self.net.parameters(), lr=self.lr, weight_decay=self.weight_decay
        )
        self.criterion = nn.BCEWithLogitsLoss()

    def fit_scaler(self, X_train: np.ndarray) -> None:
        self.scaler.partial_fit(X_train)
        if X_train.ndim == 2 and X_train.shape[1] != self.in_features and self.epoch == 0:
            self.in_features = X_train.shape[1]
            self._init_network()

    def partial_epoch(self, X: np.ndarray, y: np.ndarray) -> float:
        """One real optimization pass over mini-batches. Returns mean log-loss."""
        torch, _ = _check_torch()
        from sklearn.metrics import log_loss
        X_arr = np.asarray(X, dtype=float)
        y_arr = np.asarray(y, dtype=int).ravel()
        if X_arr.ndim != 2 or not np.all(np.isfinite(X_arr)):
            raise fail("INVALID_FEATURE", "features must be finite 2-D array")
        if not np.all(np.isin(y_arr, [0, 1])):
            raise fail("INVALID_LABEL", "labels must be binary {0, 1}")
        if len(X_arr) != len(y_arr):
            raise fail("INVALID_FEATURE", "X and y length mismatch")

        Xs = self.scaler.transform(X_arr)
        Xt = torch.from_numpy(Xs.astype(np.float32))
        yt = torch.from_numpy(y_arr.astype(np.float32)).unsqueeze(1)

        self.net.train()
        n_samples = len(X_arr)
        bs = self.batch_size if self.batch_size > 0 else n_samples

        for start in range(0, n_samples, bs):
            end = min(start + bs, n_samples)
            batch_X = Xt[start:end]
            batch_y = yt[start:end]

            self.optimizer.zero_grad()
            logits = self.net(batch_X)
            loss = self.criterion(logits, batch_y)
            loss.backward()
            self.optimizer.step()

        self.epoch += 1
        self.step += 1

        proba = self.predict_proba(X_arr)
        return float(log_loss(y_arr, proba, labels=[0, 1]))

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        torch, _ = _check_torch()
        X_arr = np.asarray(X, dtype=float)
        if X_arr.ndim != 2:
            raise fail("INVALID_FEATURE", "features must be 2-D")
        Xs = self.scaler.transform(X_arr)
        self.net.eval()
        with torch.no_grad():
            Xt = torch.from_numpy(Xs.astype(np.float32))
            logits = self.net(Xt).numpy().ravel()
            p1 = 1.0 / (1.0 + np.exp(-logits))
            p0 = 1.0 - p1
            return np.column_stack([p0, p1])

    def state_dict(self) -> dict:
        sd = {
            "solver": np.asarray(["torch-mlp"]),
            "model_type": np.asarray(["torch-mlp"]),
            "scaler_mean": np.asarray(self.scaler.mean_),
            "scaler_var": np.asarray(self.scaler.var_),
            "scaler_n": np.asarray([self.scaler.n_]),
            "epoch": np.asarray([self.epoch]),
            "step": np.asarray([self.step]),
            "in_features": np.asarray([self.in_features]),
            "hidden_dims": np.asarray(list(self.hidden_dims), dtype=int),
            "activation": np.asarray([self.activation_name]),
            "lr": np.asarray([float(self.lr)]),
            "weight_decay": np.asarray([float(self.weight_decay)]),
            "batch_size": np.asarray([int(self.batch_size)]),
            "seed": np.asarray([int(self.random_state)]),
        }
        for k, v in self.net.state_dict().items():
            sd[f"param_{k}"] = v.detach().cpu().numpy()

        # Save optimizer state for exact resume
        opt_sd = self.optimizer.state_dict()
        for idx, (p_id, state_val) in enumerate(opt_sd.get("state", {}).items()):
            step_v = state_val.get("step", 0)
            if hasattr(step_v, "item"):
                step_v = step_v.item()
            sd[f"opt_state_{idx}_step"] = np.asarray([float(step_v)])
            if "exp_avg" in state_val:
                sd[f"opt_state_{idx}_exp_avg"] = state_val["exp_avg"].detach().cpu().numpy()
            if "exp_avg_sq" in state_val:
                sd[f"opt_state_{idx}_exp_avg_sq"] = state_val["exp_avg_sq"].detach().cpu().numpy()
        return sd

    def load_state_dict(self, d: dict) -> None:
        torch, _ = _check_torch()
        self.scaler.mean_ = np.asarray(d["scaler_mean"])
        self.scaler.var_ = np.asarray(d["scaler_var"])
        self.scaler.n_ = int(np.asarray(d["scaler_n"]).ravel()[0])
        self.epoch = int(np.asarray(d["epoch"]).ravel()[0])
        self.step = int(np.asarray(d["step"]).ravel()[0])
        if "in_features" in d:
            self.in_features = int(np.asarray(d["in_features"]).ravel()[0])
        if "hidden_dims" in d:
            self.hidden_dims = tuple(np.asarray(d["hidden_dims"]).tolist())
        if "activation" in d:
            self.activation_name = str(np.asarray(d["activation"]).ravel()[0])
        if "lr" in d:
            self.lr = float(np.asarray(d["lr"]).ravel()[0])
        if "weight_decay" in d:
            self.weight_decay = float(np.asarray(d["weight_decay"]).ravel()[0])
        if "batch_size" in d:
            self.batch_size = int(np.asarray(d["batch_size"]).ravel()[0])
        if "seed" in d:
            self.random_state = int(np.asarray(d["seed"]).ravel()[0])

        params = {}
        for k, v in d.items():
            if k.startswith("param_"):
                raw_k = k[len("param_"):]
                params[raw_k] = torch.from_numpy(np.asarray(v))

        # Align in_features if inferred from weights
        first_weight_key = "0.weight"
        if first_weight_key in params:
            self.in_features = params[first_weight_key].shape[1]

        self._init_network()
        self.net.load_state_dict(params)

        # Restore optimizer state if saved
        opt_state = {}
        for idx, param in enumerate(self.net.parameters()):
            p_step_key = f"opt_state_{idx}_step"
            if p_step_key in d:
                step_val = float(np.asarray(d[p_step_key]).ravel()[0])
                st = {"step": torch.tensor(step_val)}
                if f"opt_state_{idx}_exp_avg" in d:
                    st["exp_avg"] = torch.from_numpy(np.asarray(d[f"opt_state_{idx}_exp_avg"]))
                if f"opt_state_{idx}_exp_avg_sq" in d:
                    st["exp_avg_sq"] = torch.from_numpy(np.asarray(d[f"opt_state_{idx}_exp_avg_sq"]))
                opt_state[param] = st
        if opt_state:
            self.optimizer.state.update(opt_state)

    def to_artifact_payload(self) -> dict:
        return {
            "model_type": "torch-mlp",
            "solver": "torch-mlp",
            "scaler_mean": np.asarray(self.scaler.mean_),
            "scaler_var": np.asarray(self.scaler.var_),
            "classes": self.classes_,
            "in_features": self.in_features,
            "hidden_dims": self.hidden_dims,
            "activation": self.activation_name,
            "state_dict": {k: v.detach().cpu().numpy() for k, v in self.net.state_dict().items()},
            "config": {
                "in_features": self.in_features,
                "hidden_dims": list(self.hidden_dims),
                "activation": self.activation_name,
                "lr": self.lr,
                "weight_decay": self.weight_decay,
                "batch_size": self.batch_size,
                "random_state": self.random_state,
            },
        }

    @classmethod
    def predict_proba_from_artifact_payload(cls, art: dict, Xs: np.ndarray) -> np.ndarray:
        torch, nn = _check_torch()
        hidden_dims = tuple(art.get("hidden_dims", (32, 16)))
        activation = str(art.get("activation", "relu"))
        in_features = int(art.get("in_features", Xs.shape[1]))

        layers = []
        prev = in_features
        for h in hidden_dims:
            layers.append(nn.Linear(prev, h))
            layers.append(_get_activation(activation))
            prev = h
        layers.append(nn.Linear(prev, 1))
        net = nn.Sequential(*layers)

        sd = {k: torch.from_numpy(np.asarray(v)) for k, v in art["state_dict"].items()}
        net.load_state_dict(sd)
        net.eval()
        with torch.no_grad():
            Xt = torch.from_numpy(np.asarray(Xs, dtype=np.float32))
            logits = net(Xt).numpy().ravel()
            p1 = 1.0 / (1.0 + np.exp(-logits))
            p0 = 1.0 - p1
            return np.column_stack([p0, p1])


def predict_proba_from_artifact(art: dict, X: np.ndarray) -> np.ndarray:
    scale = np.sqrt(np.maximum(art["scaler_var"], 1e-12))
    Xs = (np.asarray(X, dtype=float) - art["scaler_mean"]) / scale
    if art.get("model_type") == "torch-mlp" or art.get("solver") == "torch-mlp":
        return TorchMLP.predict_proba_from_artifact_payload(art, Xs)
    logits = Xs @ np.asarray(art["coef"]).T + np.asarray(art["intercept"])
    p1 = 1.0 / (1.0 + np.exp(-logits.ravel()))
    p0 = 1.0 - p1
    return np.column_stack([p0, p1])


def make_model(model_type: str, alpha: float = 0.0001, random_state: int = 7,
               max_iter: int = 1000, **kwargs):
    """Solver factory. Unknown types fail closed (no silent fallback)."""
    if model_type == "sgd-logloss":
        return MarketMLP(alpha=alpha, random_state=random_state)
    if model_type == "logreg-lbfgs":
        return LogRegLBFGS(alpha=alpha, random_state=random_state, max_iter=max_iter)
    if model_type in ("torch-mlp", "pytorch-mlp", "mlp"):
        mlp_kwargs = dict(kwargs)
        if "weight_decay" not in mlp_kwargs:
            mlp_kwargs["weight_decay"] = alpha
        return TorchMLP(random_state=random_state, **mlp_kwargs)
    raise fail("INVALID_CONFIG", f"unsupported model_type: {model_type}")


def save_checkpoint(path: str, model, meta: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path):
        raise fail("INVALID_CONFIG", f"checkpoint exists (immutable): {path}")
    np.savez(path, **model.state_dict(),
             meta_json=np.asarray([json.dumps(meta, sort_keys=True)]))


def load_checkpoint(path: str, model) -> dict:
    if not os.path.exists(path):
        raise fail("CHECKPOINT_CORRUPT", f"missing checkpoint: {path}")
    try:
        z = np.load(path, allow_pickle=False)
        model.load_state_dict({k: z[k] for k in z.files if k != "meta_json"})
        return json.loads(str(z["meta_json"][0]))
    except Exception as e:
        raise fail("CHECKPOINT_CORRUPT", f"{path}: {e}")

