# Graph Report - AURIX  (2026-10-15)

## Corpus Check
- 28 files · ~176,723 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2894 nodes · 7006 edges · 157 communities (127 shown, 30 thin omitted)
- Extraction: 95% EXTRACTED · 5% INFERRED · 0% AMBIGUOUS · INFERRED: 354 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Portfolio Service
- Python Datasets CLI
- Training CLI Stop Control
- Execution Service Engine
- Research Demo Tests
- Research Agents
- Training CLI Commands
- Backtest Verify Scripts
- Governed Experiment Lifecycle
- Backup Restore Runs
- Execution Service Audit
- Python Research Cycle
- Web TS Config
- Backtest Dataset Adjustments
- Broker Simulator
- Python CLI System Init
- Strategy Family Presets
- Backtest Corporate Actions
- Knowledge Store Proposals
- Gateway Verify Scripts
- Sync Manager Trust
- Research Agent Tests
- TypeScript Config
- Backtest Gate Verify Scripts
- Package Metadata
- Model Checkpoints Training
- Experiment Commit Bridge
- Knowledge Store Queries
- Python Data Tooling
- Portfolio Verify Scripts
- Broker Kite Scaffold
- Execution Planner Intents
- Package Import Audit
- Sync Manager Conflicts
- Web App Shell
- Knowledge Export Verify
- Experiment Reuse Degradation
- Research Orchestrator Context
- Phase Task Plans
- TS Build Config
- Hypothesis Hashing Dedup
- Web Package Manifest
- Synthetic Dataset Manifests
- Memory Freshness Scoring
- Hypothesis Strategy Bridge
- Sync Transport Layout
- Contracts Instrument Types
- Knowledge Service Tests
- Memory Verify Scripts
- Local Training API Docs
- TS Experiment Registry
- Sync Crypto Keys
- Phase Audit Rationales
- Walkforward Stress Tests
- Event Bus
- Logistic Regression Models
- Backtest Package Deps
- Python API Server Tests
- Backtest Security Tests
- Execution Verify Scripts
- Python Orchestrate Tests
- Experiment Reuse Registry
- Kill Switches
- Backtest Engine Tests
- Research Ingest Proposals
- Broker Kite Disabled
- Memory Manager Deps
- Memory Sync Conflict Tables
- Laya Probe
- Kill Switches Registry
- Sync Protocol Compat
- Python Execution Parity
- Portfolio Service Deps
- Sync Manager Deps
- Dashboard Read-Only Tests
- Eligibility Registry
- Web UI Cards
- Execution Strategy Parity Tests
- Execution Service Deps
- Sync Manager Deps
- Web Format Helpers
- Boundary Lint Rules
- Broker Port Interface
- Dashboard Auth Handler
- Broker Kite Deps
- Broker Sim Deps
- U-Decision Audit Trail
- Config Loader Deps
- Portfolio Package Deps
- Python Knowledge Policy
- TS Base Config
- Web Router Placeholders
- Web UI Badge
- Python Memory Parity
- Python Portfolio Parity
- Python Research Parity
- Python Sync Parity
- Knowledge Service Deps
- Model Gateway Deps
- Orchestrator Deps
- Web Runtime Deps
- Execution Interface Deps
- Observability Deps
- Safety Gate Deps
- Portfolio Engine Deps
- Risk Engine Deps
- Strategy Package Deps
- Python Workspace Stubs
- Web Dev Deps
- Policy Promotion Docs
- Python Strategy Parity
- Policy Seed Docs
- Audit Safety Chain
- DB Bootstrap DDL
- API Package Stub
- System Health Stub
- README Config Overview
- Contracts Deps
- DB Bootstrap Deps
- Event Bus Deps
- Market Data Deps
- Gateway Client Deps
- Sync Protocol Deps
- SQLite Verify Scripts
- Web API Client Docs
- Web Backend Contract Docs
- Readiness Report Docs
- Portfolio Exposure Math
- Policy Documents Hub
- AGENTS Safety Path Nodes
- System Health Safe Mode
- Rate Limit Bucket
- Dashboard Abort Tests
- AI Training TODO Docs
- Web Entry Files
- Broker Docs Concepts
- Risk Policy Phase Docs
- Gateway Client Types
- Commit Hook Entries
- Data Intake Policy Pair
- Live Trading Policy Pair
- Workflow Graphify Policy Pair
- Training Protection Policy Pair
- Knowledge Events Docs
- Laya Decision Docs
- Sync Encryption Docs
- Freshness Policy Singleton
- Pnpm Workspace Root
- Market Data Plan Fragment
- Research Plan Fragment
- Research Plan Fragment
- Live Gate Plan Fragment B

## God Nodes (most connected - your core abstractions)
1. `vitest` - 82 edges
2. `KnowledgeStore` - 73 edges
3. `SyncManager` - 55 edges
4. `ExperimentRegistry` - 54 edges
5. `fail()` - 42 edges
6. `stableStringify()` - 42 edges
7. `MemoryManager` - 38 edges
8. `BrokerSim` - 36 edges
9. `build_parser()` - 35 edges
10. `Scheduler` - 34 edges

## Surprising Connections (you probably didn't know these)
- `Experiment Lifecycle QUEUED to VALIDATED` --references--> `Scheduler`  [EXTRACTED]
  AGENTS.md → services-python/aurix_ai/orchestrate.py
- `Model registry CANDIDATE to ACTIVE promotion chain` --semantically_similar_to--> `LiveTradingPromotion hard live gate`  [INFERRED] [semantically similar]
  config/ai-policy.v1.yaml → docs/architecture.md
- `Tej-Bazaar NSE EOD history source` --semantically_similar_to--> `Intake-only research scope no scraping`  [INFERRED] [semantically similar]
  README.md → docs/audit/research-connectors-decision.md
- `Experiment Lifecycle QUEUED to VALIDATED` --references--> `ExperimentRegistry`  [EXTRACTED]
  AGENTS.md → services-python/aurix_ai/orchestrate.py
- `BrokerSim` --implements--> `BrokerPort`  [EXTRACTED]
  apps/brokers/broker-sim/src/index.ts → packages/execution-interface/src/index.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Safe execution chain Risk Gate Broker** — docs_audits_phase_1_audit_order_safety_gate, docs_audits_phase_7_audit_risk_veto, docs_audits_phase_8_audit_execution_state_machine [EXTRACTED 0.85]
- **Fail-Closed Safety Flow** — agents_trading_safety_veto_only, agents_fail_closed_order_path, agents_disabled_live_trading_controls [EXTRACTED 1.00]
- **Governed Training Promotion** — agents_experiment_lifecycle, agents_governed_promotion_gates, agents_isolated_training_workload [EXTRACTED 1.00]
- **Knowledge Integrity Flow** — agents_knowledge_store_append_only, agents_propose_validate_commit, agents_memory_freshness_bands [EXTRACTED 1.00]
- **Fail-closed safety flow Risk Gate Promotion** — docs_architecture_risk_engine, docs_architecture_order_safety_gate, docs_architecture_live_promotion, config_default_safety_policy [EXTRACTED 1.00]
- **Knowledge evidence lineage** — docs_audits_phase_2_audit_knowledge_validation, docs_audits_phase_2_audit_provenance_preservation, docs_audits_phase_5_audit_evidence_provenance [INFERRED 0.75]
- **Memory-first research and strategy loop** — tasks_phase_4_plan_memory_manager, tasks_phase_5_plan_research_orchestrator, tasks_phase_6_plan_backtest_engine [INFERRED 0.75]
- **Training automation loop** — docs_training_automation_supervisor, docs_training_automation_governance_gates, docs_training_research_research_cycle [INFERRED 0.75]
- **Governed training to promotion chain** — readme_market_ml_model, config_ai_policy_v1_governance_gates, config_ai_policy_v1_model_registry, docs_audit_master_spec_reconstruction_r11_governance [INFERRED 0.85]
- **Phased plan to todo implementation pairs** — tasks_phase_2_plan_knowledge_platform, tasks_phase_6_plan_strategy_intelligence, tasks_phase_7_plan_portfolio_construction, tasks_phase_8_plan_execution_service [INFERRED 0.85]
- **Milestone 1 read-only web dashboard stack and API surface** — apps_web_readme_dashboard, apps_web_readme_frontend_stack, apps_web_readme_backend_service, apps_web_readme_api_surface, apps_web_readme_auth_model [EXTRACTED 1.00]
- **Static dashboard login session plus read-only health state events flow** — services_python_aurix_ai_dashboard_dashboard_page, services_python_aurix_ai_dashboard_loginform, services_python_aurix_ai_dashboard_api_client, services_python_aurix_ai_dashboard_health_view, services_python_aurix_ai_dashboard_training_state, services_python_aurix_ai_dashboard_event_history [EXTRACTED 1.00]
- **AI training backlog Python package policy and verification** — tasks_ai_training_todo_training_backlog, tasks_ai_training_todo_python_package, tasks_ai_training_todo_ai_policy, tasks_ai_training_todo_verification [EXTRACTED 1.00]

## Communities (157 total, 30 thin omitted)

### Community 0 - "Portfolio Service"
Cohesion: 0.06
Nodes (74): PipelineResult, PORTFOLIO_CODE_VERSION, PortfolioService, baseReq(), cand(), market(), setup(), allocateConfidence() (+66 more)

### Community 1 - "Python Datasets CLI"
Cohesion: 0.07
Nodes (42): _cmd_dataset(), _cmd_history_build(), build_features_labels(), chrono_split(), dataset_version_id(), DatasetSpec, generate_ohlcv(), load_dataset() (+34 more)

### Community 2 - "Training CLI Stop Control"
Cohesion: 0.07
Nodes (36): _auto_stop_inner(), stop(), main(), default_launcher(), emit_event(), heartbeat_trusted(), latest_checkpoint(), pid_alive() (+28 more)

### Community 3 - "Execution Service Engine"
Cohesion: 0.06
Nodes (44): EngineConfig, SubmitInputs, AuditEvent, DEFAULT_LEDGER_CONFIG, isTerminal(), LedgerConfig, classifyFailure(), DEFAULT_RETRY_POLICY (+36 more)

### Community 4 - "Research Demo Tests"
Cohesion: 0.07
Nodes (34): demoAsk(), RULES, advance(), commitMemory(), commitNode(), makeManager(), NOW, prov() (+26 more)

### Community 5 - "Research Agents"
Cohesion: 0.13
Nodes (37): EventIntelligenceAgent, FundamentalAgent, groupByMetric(), metricEvidence(), MetricPoint, indicatorEvidence(), MacroAgent, classifySentiment() (+29 more)

### Community 6 - "Training CLI Commands"
Cohesion: 0.09
Nodes (40): _auto_train_impl(), _auto_train_supervised(), _auto_train_supervised_result(), build_parser(), _cmd_auto_cycle(), _cmd_auto_logs(), _cmd_auto_retry(), _cmd_auto_start() (+32 more)

### Community 7 - "Backtest Verify Scripts"
Cohesion: 0.04
Nodes (31): again, bad, baseReq, calendar, closes, COST, dataset, db (+23 more)

### Community 8 - "Governed Experiment Lifecycle"
Cohesion: 0.08
Nodes (28): Experiment Lifecycle QUEUED to VALIDATED, _cmd_interactive(), build(), counts(), start(), system(), ExperimentRegistry, build_state() (+20 more)

### Community 9 - "Backup Restore Runs"
Cohesion: 0.07
Nodes (26): backup_runs(), _copy(), restore_backup(), _sha_file(), verify_backup(), AITrainingError, fail(), _get() (+18 more)

### Community 10 - "Execution Service Audit"
Cohesion: 0.10
Nodes (12): ExecutionService, mapBrokerError(), validateBrokerResponse(), ExecutionLedger, TokenBucket, OrderStatus, applyFill(), canTransition() (+4 more)

### Community 11 - "Python Research Cycle"
Cohesion: 0.10
Nodes (34): _append_record(), best_edge_from(), classify_outcome(), derive_questions(), ask(), _hid(), known_fingerprints(), make_hypothesis() (+26 more)

### Community 12 - "Web TS Config"
Cohesion: 0.05
Nodes (42): compilerOptions, jsx, lib, module, moduleResolution, noEmit, types, extends (+34 more)

### Community 13 - "Backtest Dataset Adjustments"
Cohesion: 0.12
Nodes (37): AdjustedSeries, adjustSeries(), BacktestDataset, barsAsOf(), buildDataset(), DatasetBar, DatasetEvent, DatasetFundamental (+29 more)

### Community 14 - "Broker Simulator"
Cohesion: 0.11
Nodes (10): BrokerSim, INSTRUMENTS, SimFaults, BrokerAuth, BrokerError, BrokerInstrument, BrokerOrder, BrokerPosition (+2 more)

### Community 15 - "Python CLI System Init"
Cohesion: 0.08
Nodes (15): _cmd_registry(), ModelRegistry, detect_resources(), _nvidia_smi(), ResourceReport, select_device(), _torch_probe(), assert_no_secrets() (+7 more)

### Community 16 - "Strategy Family Presets"
Cohesion: 0.16
Nodes (30): evaluateCondition(), evaluateIndicator(), FamilyPreset, KNOWN_INDICATORS, KNOWN_OPERATORS, registerFamily(), donchian(), roc() (+22 more)

### Community 17 - "Backtest Corporate Actions"
Cohesion: 0.10
Nodes (30): advFor(), applyCorporateActions(), applyDividends(), BACKTEST_CODE_VERSION, barsPerYear(), buildEquity(), EngineState, EventWindow (+22 more)

### Community 18 - "Knowledge Store Proposals"
Cohesion: 0.15
Nodes (11): buildExport(), KnowledgeStore, KnowledgeTables, Row, InnerPackage, SyncManagerOptions, KnowledgeEdge, KnowledgeEvent (+3 more)

### Community 19 - "Gateway Verify Scripts"
Cohesion: 0.05
Nodes (37): artifact, artifact_sha256, checkpoints, code_version, configuration, alpha, configuration_hash, model_type (+29 more)

### Community 20 - "Sync Manager Trust"
Cohesion: 0.10
Nodes (26): KnowledgeStore Append-Only Event Semantics, Propose Validate Commit Workflow, sha256Hex(), verifyExport(), appendKnowledgeEvent(), KnowledgeEventStore, VALID_LABELS, validateKnowledgeEvent() (+18 more)

### Community 21 - "Research Agent Tests"
Cohesion: 0.13
Nodes (26): buildResearchContext(), corpActionToEvent(), EVENT_TYPES, invalidationTopicsFor(), assessBar(), assessQuote(), baseRef(), classifyDataAge() (+18 more)

### Community 22 - "TypeScript Config"
Cohesion: 0.07
Nodes (16): device(), memStack(), now(), results, sqliteStack(), affected, bad, badReport (+8 more)

### Community 23 - "Backtest Gate Verify Scripts"
Cohesion: 0.17
Nodes (16): EV1, boom, hanging, advance(), barAt(), bars(), macroEv(), makeResearch() (+8 more)

### Community 24 - "Package Metadata"
Cohesion: 0.09
Nodes (20): createDraftPromotion(), isLiveAllowed(), LIVE_MODES, ModeMachine, ModeTransition, ORDER_MODES, applyEnvOverlay(), AurixConfig (+12 more)

### Community 25 - "Model Checkpoints Training"
Cohesion: 0.07
Nodes (20): args, bars, base, calendar, conditions, dataset, from, run (+12 more)

### Community 26 - "Experiment Commit Bridge"
Cohesion: 0.06
Nodes (31): description, devDependencies, js-yaml, @types/js-yaml, @types/node, typescript, vitest, js-yaml (+23 more)

### Community 27 - "Knowledge Store Queries"
Cohesion: 0.14
Nodes (19): _cmd_resume(), load_checkpoint(), make_model(), utc_ms(), base_rate_loss(), diagnose_run(), _framework_versions(), run_training() (+11 more)

### Community 28 - "Python Data Tooling"
Cohesion: 0.07
Nodes (18): bad, big, cand(), db, empty, hybrid, kvBefore, market() (+10 more)

### Community 29 - "Portfolio Verify Scripts"
Cohesion: 0.13
Nodes (22): _bar(), clear(), _fmt_elapsed(), _last_outcome_line(), read_key(), render_failure(), render_logs(), render_menu() (+14 more)

### Community 30 - "Broker Kite Scaffold"
Cohesion: 0.12
Nodes (16): createBroker(), KITE_ACTIVATION_CHECKLIST, SimOrder, routeOrder(), RouteRequest, INSTRUMENT, Instrument, OrderCmd (+8 more)

### Community 31 - "Execution Planner Intents"
Cohesion: 0.13
Nodes (16): DEFAULT_ENGINE_CONFIG, resetEngineSeqForTests(), planExecutionRequest(), PortfolioIntent, resetPlannerSeqForTests(), INSTRUMENT, serviceWithSim(), INSTRUMENT (+8 more)

### Community 32 - "Package Import Audit"
Cohesion: 0.10
Nodes (5): InspectedPackage, SyncError, Logger, KnowledgeTransferTransport, SyncManifest

### Community 33 - "Sync Manager Conflicts"
Cohesion: 0.13
Nodes (5): SyncManager, importWithCrash(), SyncEnvelope, TrustEntry, VersionVector

### Community 34 - "Web App Shell"
Cohesion: 0.15
Nodes (24): ConnectionBadge(), useConnectionState(), Layout(), NAV, ScaleIcon(), API_TIMEOUT_MS, ApiError, baseUrl() (+16 more)

### Community 35 - "Knowledge Export Verify"
Cohesion: 0.09
Nodes (11): c1, db, pkg, rebuilt, store, A, B, commitCompany() (+3 more)

### Community 36 - "Experiment Reuse Degradation"
Cohesion: 0.15
Nodes (12): commitExperimentResult(), commitHypothesis(), decideExperiment(), experimentSpecHash(), recordStrategyMemory(), DEF(), record(), setup() (+4 more)

### Community 37 - "Research Orchestrator Context"
Cohesion: 0.16
Nodes (15): ResearchContextRequest, ResearchRequest, Interpreter, StubProvider, BarProvider, CanonicalBar, CanonicalQuote, CorporateActionProvider (+7 more)

### Community 38 - "Phase Task Plans"
Cohesion: 0.08
Nodes (23): Cumulative Phase 1-5 Audit TODO, Knowledge Platform with Evidence and Provenance, KnowledgeService facade, Phase 2 store core tasks, Conflict detection and resolution, Sync manager deterministic engine, Sync protocol types, Phase 3 sync engine tasks (+15 more)

### Community 39 - "TS Build Config"
Cohesion: 0.07
Nodes (27): compilerOptions, noEmit, outDir, paths, types, extends, include, ./tsconfig.base.json (+19 more)

### Community 40 - "Hypothesis Hashing Dedup"
Cohesion: 0.20
Nodes (8): buildHypothesis(), cyrb53hex(), stableStringify(), isRecord(), num(), KnowledgeProposal, ProposalOp, ProvenanceInput

### Community 41 - "Web Package Manifest"
Cohesion: 0.08
Nodes (23): description, name, private, scripts, build, dev, preview, typecheck (+15 more)

### Community 42 - "Synthetic Dataset Manifests"
Cohesion: 0.07
Nodes (26): checksum_sha256, class_balance, neg, pos, created_at, dataset_id, dataset_version, date_range (+18 more)

### Community 43 - "Memory Freshness Scoring"
Cohesion: 0.17
Nodes (21): classifyMemoryAge(), FreshnessPolicy, jaccardSimilarity(), MEMORY_FRESHNESS, MemoryDomain, MemoryFreshness, normalizeTaskKey(), normalizeText() (+13 more)

### Community 44 - "Hypothesis Strategy Bridge"
Cohesion: 0.13
Nodes (18): buildStrategyFromHypothesis(), describeWithInterpreter(), HypothesisInput, InterpreterLike, StrategyBuildInput, MODELS, SCOPE, SourceType (+10 more)

### Community 45 - "Sync Transport Layout"
Cohesion: 0.15
Nodes (6): DIRS, ensureLayout(), LocalFilesystemTransport, STIGNORE, SyncthingTransport, isValidPackageName()

### Community 46 - "Contracts Instrument Types"
Cohesion: 0.10
Nodes (20): BrokerConstraints, ContractSpec, DecisionAction, DecisionRecord, DEFAULT_SOURCE_QUALITY, EmbeddingRecord, EntityStatus, ExportManifest (+12 more)

### Community 47 - "Knowledge Service Tests"
Cohesion: 0.28
Nodes (12): KnowledgeError, built(), makeStore(), nodeInput(), prov(), resetFixtures(), CATEGORIES, embInput() (+4 more)

### Community 48 - "Memory Verify Scripts"
Cohesion: 0.09
Nodes (16): bar, byTopic, d0, d1, d2, d3, db, dup (+8 more)

### Community 49 - "Local Training API Docs"
Cohesion: 0.18
Nodes (6): Loopback Bearer-Token Training API, _audit_log(), _read_events(), token_fingerprint(), TrainingAPIHandler, _utc_ms()

### Community 50 - "TS Experiment Registry"
Cohesion: 0.17
Nodes (4): ExperimentRegistry, StrategyRegistry, setup(), StrategyStatus

### Community 51 - "Sync Crypto Keys"
Cohesion: 0.19
Nodes (18): edSign(), edVerify(), generateBoxKeypair(), generateSignKeypair(), openSealed(), SealedEnvelope, sealToRecipient(), sha256hexText() (+10 more)

### Community 52 - "Phase Audit Rationales"
Cohesion: 0.11
Nodes (13): Mode Machine and Promotion Gate isLiveAllowed false, Provenance and History Preservation append-only, Data Quality Fail-safe Quarantine, Evidence Provenance Bundles, OOS Walk-forward Stress Robustness, eod2_data SECONDARY CSV Validation, tej-bazaar PRIMARY NSE BSE Parquet, Automated Training Supervisor auto-cycle (+5 more)

### Community 53 - "Walkforward Stress Tests"
Cohesion: 0.19
Nodes (14): _approved_gates(), _bars(), _governed_fixture(), _run_gate(), test_extended_infra_failure_is_failed(), test_gate_stress_mode(), test_gate_walkforward_mode(), test_gate_walkforward_rejects_bad_spec() (+6 more)

### Community 54 - "Event Bus"
Cohesion: 0.17
Nodes (7): BusEvent, EventBus, EventStore, Row, toEvent(), MemoryStore, Row

### Community 56 - "Backtest Package Deps"
Cohesion: 0.11
Nodes (18): dependencies, @aurix/contracts, @aurix/knowledge-service, @aurix/market-data, @aurix/memory-manager, @aurix/observability, @aurix/strategy, @aurix/contracts (+10 more)

### Community 57 - "Python API Server Tests"
Cohesion: 0.20
Nodes (11): TrainingAPIServer, _req(), _serve(), test_audit_log_redacts_tokens(), test_malformed_interval_and_timeout_rejected(), test_missing_token_refuses_startup(), test_rate_limit_and_body_cap(), test_socket_concurrency_serialized_safely() (+3 more)

### Community 58 - "Backtest Security Tests"
Cohesion: 0.36
Nodes (8): divergedPair(), commitCompany(), makeDevice(), prov(), sendTo(), TestDevice, trustEachOther(), pairWithWork()

### Community 59 - "Execution Verify Scripts"
Cohesion: 0.12
Nodes (12): hasBroker(), INSTRUMENT, layers, makeSvc(), now(), portfolioDecision, researchObservation, results (+4 more)

### Community 60 - "Python Orchestrate Tests"
Cohesion: 0.31
Nodes (15): _def(), _governed(), _sched(), _seed_dataset(), test_dead_worker_without_checkpoint_restarts_cleanly(), test_evaluation_transition_real_artifact(), test_failed_heartbeat_marks_failed_with_diagnostic(), test_governance_blocks_weak_model() (+7 more)

### Community 61 - "Experiment Reuse Registry"
Cohesion: 0.13
Nodes (13): allowedTransition(), DegradationEntry, FROM_DEGRADED, StoredExperiment, TERMINAL, BenchmarkComparison, compareBenchmark(), evaluateStrategy() (+5 more)

### Community 62 - "Kill Switches"
Cohesion: 0.13
Nodes (4): KillSwitchCheck, KillSwitchManager, KillSwitchInput, KillSwitchSnapshot

### Community 63 - "Backtest Engine Tests"
Cohesion: 0.12
Nodes (16): dependencies, @aurix/contracts, @aurix/knowledge-service, @aurix/market-data, @aurix/memory-manager, @aurix/observability, @aurix/contracts, @aurix/knowledge-service (+8 more)

### Community 64 - "Research Ingest Proposals"
Cohesion: 0.13
Nodes (6): DashboardSessions, main(), _page_bytes(), serve_dashboard(), _session_cookie_header(), test_dashboard_refuses_bad_startup()

### Community 65 - "Broker Kite Disabled"
Cohesion: 0.17
Nodes (12): EligibilityState, EligibilityRecord, EligibilityResolution, isTradable(), KNOWN_STATES, resolveEligibility(), seedEligibility(), seed() (+4 more)

### Community 66 - "Memory Manager Deps"
Cohesion: 0.30
Nodes (13): BacktestRequest, req(), bars(), datasetFor(), DAY, LOOSE_LIQ, rocStrategy(), T0 (+5 more)

### Community 68 - "Laya Probe"
Cohesion: 0.23
Nodes (3): ResearchOrchestrator, ResearchResultBundle, MarketEvent

### Community 70 - "Sync Protocol Compat"
Cohesion: 0.19
Nodes (6): codec(), keyOf(), SqliteTables, SYNC_SNAPSHOT_TABLES, TableSnapshot, KnowledgeConflictError

### Community 71 - "Python Execution Parity"
Cohesion: 0.13
Nodes (14): dependencies, @aurix/contracts, @aurix/knowledge-service, @aurix/market-data, @aurix/observability, @aurix/contracts, @aurix/knowledge-service, @aurix/market-data (+6 more)

### Community 72 - "Portfolio Service Deps"
Cohesion: 0.13
Nodes (14): dependencies, @aurix/contracts, @aurix/knowledge-service, @aurix/memory-manager, @aurix/portfolio, @aurix/contracts, @aurix/knowledge-service, @aurix/memory-manager (+6 more)

### Community 73 - "Sync Manager Deps"
Cohesion: 0.17
Nodes (13): checkSchemaCompat(), ConflictClass, DryRunReport, majorOf(), MergeOutcome, OriginRange, PACKAGE_SUFFIX, ResolutionAction (+5 more)

### Community 74 - "Dashboard Read-Only Tests"
Cohesion: 0.34
Nodes (12): _login(), _req(), _serve(), test_dashboard_bearer_still_works(), test_dashboard_login_logout_still_work(), test_dashboard_page_has_no_state_changing_surface(), test_dashboard_post_is_read_only(), test_dashboard_reads_public_on_loopback() (+4 more)

### Community 75 - "Eligibility Registry"
Cohesion: 0.20
Nodes (12): buildResearchProposal(), ingestResearchRecords(), IngestSummary, LABEL_BY_RECORD, recordKey(), RESEARCH_AGENT_ACTOR, RESEARCH_INGEST_VERSION, RESEARCH_MEMORY_CATEGORY (+4 more)

### Community 76 - "Web UI Cards"
Cohesion: 0.31
Nodes (9): Card(), CardTitle(), Skeleton(), cn(), ENDPOINTS, opts, SystemHealth(), clsx (+1 more)

### Community 77 - "Execution Strategy Parity Tests"
Cohesion: 0.21
Nodes (6): classify_retry(), is_autonomous_live_enabled(), transition_allowed(), test_autonomous_live_disabled(), test_retry_classes(), test_unknown_must_reconcile()

### Community 78 - "Execution Service Deps"
Cohesion: 0.15
Nodes (12): dependencies, @aurix/contracts, @aurix/execution-interface, @aurix/order-safety-gate, @aurix/contracts, @aurix/execution-interface, main, name (+4 more)

### Community 79 - "Sync Manager Deps"
Cohesion: 0.15
Nodes (12): dependencies, @aurix/contracts, @aurix/observability, @aurix/sync-protocol, @aurix/contracts, @aurix/observability, main, name (+4 more)

### Community 80 - "Web Format Helpers"
Cohesion: 0.33
Nodes (8): collectEventTypes(), filterEvents(), formatElapsed(), progressFraction(), fmt(), fmtTime(), opts, Training()

### Community 81 - "Boundary Lint Rules"
Cohesion: 0.15
Nodes (12): EXEC_FILES, EXEC_IFACE_FILES, FORBIDDEN, GUARDED, KITE_FILES, KNOWLEDGE_FILES, PHASE4_FILES, PORTFOLIO_FILES (+4 more)

### Community 84 - "Broker Kite Deps"
Cohesion: 0.18
Nodes (10): dependencies, @aurix/contracts, @aurix/execution-interface, @aurix/contracts, @aurix/execution-interface, main, name, type (+2 more)

### Community 85 - "Broker Sim Deps"
Cohesion: 0.18
Nodes (10): dependencies, @aurix/contracts, @aurix/execution-interface, @aurix/contracts, @aurix/execution-interface, main, name, type (+2 more)

### Community 86 - "U-Decision Audit Trail"
Cohesion: 0.20
Nodes (10): U4 U8 U10 verified dependency chain, U4 adjusted-price default policy, U7 live research connectors decided cut, U8 walk-forward stress threshold floors, Missing autonomous closed-loop outcome reader, P1 autonomy core outcome reader planner, Final decision sheet U1-U10 Phase-4 approval, Phase-4 backend acceptance audit verdict (+2 more)

### Community 87 - "Config Loader Deps"
Cohesion: 0.18
Nodes (10): dependencies, @aurix/contracts, js-yaml, @aurix/contracts, js-yaml, main, name, type (+2 more)

### Community 88 - "Portfolio Package Deps"
Cohesion: 0.18
Nodes (10): dependencies, @aurix/contracts, @aurix/strategy, @aurix/contracts, @aurix/strategy, main, name, type (+2 more)

### Community 89 - "Python Knowledge Policy"
Cohesion: 0.25
Nodes (4): can_promote_to_fact(), downgrade_for_llm(), test_fact_promotion_rule(), test_llm_fact_downgraded()

### Community 90 - "TS Base Config"
Cohesion: 0.18
Nodes (10): compilerOptions, declaration, esModuleInterop, module, moduleResolution, outDir, skipLibCheck, sourceMap (+2 more)

### Community 91 - "Web Router Placeholders"
Cohesion: 0.42
Nodes (8): router, Unavailable(), Data(), Portfolio(), Research(), Strategies(), Settings(), RiskGovernance()

### Community 92 - "Web UI Badge"
Cohesion: 0.27
Nodes (8): Badge(), BadgeProps, badgeVariants, Button(), ButtonProps, buttonVariants, class-variance-authority, react

### Community 93 - "Python Memory Parity"
Cohesion: 0.29
Nodes (4): assess_record(), classify_memory_age(), test_freshness_mirror(), test_quality_verdict_mirror()

### Community 94 - "Python Portfolio Parity"
Cohesion: 0.29
Nodes (3): drawdown_state(), risk_wins(), test_drawdown_and_risk_wins_mirrors()

### Community 95 - "Python Research Parity"
Cohesion: 0.33
Nodes (5): check_agent_result(), test_missing_fields_and_bad_status_flagged(), test_trade_fields_forbidden(), test_valid_result_passes(), _valid_result()

### Community 96 - "Python Sync Parity"
Cohesion: 0.31
Nodes (5): check_schema_compat(), _major(), triage_vectors(), test_compat_mirror(), test_triage_mirror()

### Community 97 - "Knowledge Service Deps"
Cohesion: 0.22
Nodes (8): dependencies, @aurix/contracts, @aurix/contracts, main, name, type, types, version

### Community 98 - "Model Gateway Deps"
Cohesion: 0.22
Nodes (8): dependencies, @aurix/contracts, @aurix/contracts, main, name, type, types, version

### Community 99 - "Orchestrator Deps"
Cohesion: 0.22
Nodes (8): dependencies, @aurix/contracts, @aurix/contracts, main, name, type, types, version

### Community 100 - "Web Runtime Deps"
Cohesion: 0.22
Nodes (9): dependencies, class-variance-authority, clsx, lucide-react, react, react-dom, react-router-dom, tailwind-merge (+1 more)

### Community 101 - "Execution Interface Deps"
Cohesion: 0.22
Nodes (8): dependencies, @aurix/contracts, @aurix/contracts, main, name, type, types, version

### Community 102 - "Observability Deps"
Cohesion: 0.22
Nodes (8): dependencies, @aurix/contracts, @aurix/contracts, main, name, type, types, version

### Community 103 - "Safety Gate Deps"
Cohesion: 0.22
Nodes (8): dependencies, @aurix/contracts, @aurix/contracts, main, name, type, types, version

### Community 104 - "Portfolio Engine Deps"
Cohesion: 0.22
Nodes (8): dependencies, @aurix/contracts, @aurix/contracts, main, name, type, types, version

### Community 105 - "Risk Engine Deps"
Cohesion: 0.22
Nodes (8): dependencies, @aurix/contracts, @aurix/contracts, main, name, type, types, version

### Community 106 - "Strategy Package Deps"
Cohesion: 0.22
Nodes (8): dependencies, @aurix/contracts, @aurix/contracts, main, name, type, types, version

### Community 107 - "Python Workspace Stubs"
Cohesion: 0.33
Nodes (4): generic_instrument(), is_tradable(), test_eligibility_fail_closed(), test_generic_instrument_has_no_venue_branches()

### Community 108 - "Web Dev Deps"
Cohesion: 0.25
Nodes (8): devDependencies, tailwindcss, @tailwindcss/vite, @types/react, @types/react-dom, typescript, vite, @vitejs/plugin-react

### Community 109 - "Policy Promotion Docs"
Cohesion: 0.25
Nodes (3): RESEARCH mode sim broker localhost, Mode machine RESEARCH to AUTONOMOUS_LIVE, Model gateway configurable stub Ollama

### Community 111 - "Policy Seed Docs"
Cohesion: 0.29
Nodes (3): NSE instrument seeds RELIANCE NIFTY FUT, Portfolio allocation hybrid sizing turnover, Cumulative Phase 1-5 audit PASS

### Community 112 - "Audit Safety Chain"
Cohesion: 0.29
Nodes (5): Broker Isolation sim-only Kite disabled, Execution State Machine 15 states Idempotency, Kill Switches Global Execution Strategy, Laya Agent Advisory Decision CPU, Qwen3 4B Gateway Live Inference

### Community 113 - "DB Bootstrap DDL"
Cohesion: 0.48
Nodes (4): CORE_DDL, KNOWLEDGE_DDL, PORTFOLIO_DDL, SYNC_DDL

### Community 114 - "API Package Stub"
Cohesion: 0.33
Nodes (5): main, name, type, types, version

### Community 115 - "System Health Stub"
Cohesion: 0.33
Nodes (5): main, name, type, types, version

### Community 116 - "README Config Overview"
Cohesion: 0.33
Nodes (5): AI policy v1 Qwen Laya training config, AURIX Autonomous Unified Risk and Intelligence Exchange, SGD logistic regression market model, AURIX Model Gateway, Qwen3 4B reasoning model via Ollama

### Community 117 - "Contracts Deps"
Cohesion: 0.33
Nodes (5): main, name, type, types, version

### Community 118 - "DB Bootstrap Deps"
Cohesion: 0.33
Nodes (5): main, name, type, types, version

### Community 119 - "Event Bus Deps"
Cohesion: 0.33
Nodes (5): main, name, type, types, version

### Community 120 - "Market Data Deps"
Cohesion: 0.33
Nodes (5): main, name, type, types, version

### Community 121 - "Gateway Client Deps"
Cohesion: 0.33
Nodes (5): main, name, type, types, version

### Community 122 - "Sync Protocol Deps"
Cohesion: 0.33
Nodes (5): main, name, type, types, version

### Community 123 - "SQLite Verify Scripts"
Cohesion: 0.33
Nodes (3): CORE, KNOWLEDGE, PORTFOLIO

### Community 124 - "Web API Client Docs"
Cohesion: 0.40
Nodes (6): api fetch client same-origin timeout 401 malformed handling, AURIX Local Dashboard read-only page, Event history view time type experiment detail, System health view status version, LoginForm token session cookie sign in out, Training status view stage pipeline epoch loss checkpoint

### Community 125 - "Web Backend Contract Docs"
Cohesion: 0.40
Nodes (5): Verified backend surface GET health training state events POST login logout, Loopback public GET auth model no credentials in app, Dashboard backend aurix_ai.dashboard runs port 8742 proxy 5173, AURIX Web Read-only Dashboard, Frontend Stack React 19 TypeScript Vite Tailwind shadcn Router Query

### Community 126 - "Readiness Report Docs"
Cohesion: 0.40
Nodes (5): Frontend missing interfaces experiments datasets governance risk backtest, Graphify corpus graph.json 2670 nodes manifest 324 entries, Agent Instruction Graphify Readiness Report, Safety enforcement sim-only risk veto propose validate commit, Verified training API routes health state events start stop

### Community 127 - "Portfolio Exposure Math"
Cohesion: 0.50
Nodes (3): computeExposure(), ExposureReport, PositionInput

### Community 128 - "Policy Documents Hub"
Cohesion: 0.50
Nodes (4): Approved Architecture docs/architecture.md v1.0.1, Final Decision Sheet, Master Spec Reconstruction, AURIX Engineering Operating Policy

### Community 129 - "AGENTS Safety Path Nodes"
Cohesion: 0.50
Nodes (3): TypeScript Deterministic Safety Path, Fail-Closed Order Path, Python Numerical Research Path

### Community 133 - "AI Training TODO Docs"
Cohesion: 0.50
Nodes (4): AI policy config ai-policy v1 yaml, aurix_ai Python package datasets model train registry cli, AURIX AI Training TODO backlog, Runtime proofs and verification pytest typecheck verify ai

### Community 134 - "Web Entry Files"
Cohesion: 0.67
Nodes (3): Web entry HTML shell dark AURIX title, Main TSX entry src main.tsx module script, React root div mount point

### Community 135 - "Broker Docs Concepts"
Cohesion: 0.67
Nodes (3): Broker-sim only executable broker, BrokerPort vendor-neutral abstraction, Kite disabled scaffold Phase1DisabledError

## Knowledge Gaps
- **111 isolated node(s):** `aurix-py`, `js-yaml`, `@types/js-yaml`, `@types/node`, `./tsconfig.base.json` (+106 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 1113 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **30 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `vitest` connect `Backtest Gate Verify Scripts` to `Portfolio Service`, `System Health Safe Mode`, `Execution Service Engine`, `Research Demo Tests`, `Backtest Dataset Adjustments`, `Broker Simulator`, `Strategy Family Presets`, `Backtest Corporate Actions`, `Sync Manager Trust`, `Research Agent Tests`, `Package Metadata`, `Experiment Commit Bridge`, `Broker Kite Scaffold`, `Execution Planner Intents`, `Experiment Reuse Degradation`, `Hypothesis Strategy Bridge`, `Contracts Instrument Types`, `Knowledge Service Tests`, `TS Experiment Registry`, `Event Bus`, `Backtest Security Tests`, `Experiment Reuse Registry`, `Broker Kite Disabled`, `Memory Manager Deps`, `Sync Manager Deps`, `Eligibility Registry`, `Web Format Helpers`, `DB Bootstrap DDL`, `Portfolio Exposure Math`?**
  _High betweenness centrality (0.104) - this node is a cross-community bridge._
- **What connects `aurix-py`, `js-yaml`, `@types/js-yaml` to the rest of the system?**
  _111 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Portfolio Service` be split into smaller, more focused modules?**
  _Cohesion score 0.06475247524752475 - nodes in this community are weakly interconnected._
- **Why does `KnowledgeStore` connect `Knowledge Store Proposals` to `Portfolio Service`, `Sync Manager Conflicts`, `Experiment Reuse Degradation`, `Research Demo Tests`, `Research Agents`, `Hypothesis Hashing Dedup`, `Eligibility Registry`, `Memory Freshness Scoring`, `Knowledge Service Tests`, `TS Experiment Registry`, `Sync Manager Trust`, `Backtest Gate Verify Scripts`, `Backtest Security Tests`, `Experiment Reuse Registry`?**
  _High betweenness centrality (0.019) - this node is a cross-community bridge._
- **Should `Python Datasets CLI` be split into smaller, more focused modules?**
  _Cohesion score 0.0662451068955134 - nodes in this community are weakly interconnected._
- **Why does `KillSwitchManager` connect `Kill Switches` to `Execution Service Audit`, `Execution Service Engine`?**
  _High betweenness centrality (0.013) - this node is a cross-community bridge._
- **Should `Training CLI Stop Control` be split into smaller, more focused modules?**
  _Cohesion score 0.06905370843989769 - nodes in this community are weakly interconnected._