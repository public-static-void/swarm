---
name: cicd-skill
description: CI/CD pipeline and deployment skill covering pipeline design, deployment configurations, environment management, rollback procedures, health checks, secrets management, and artifact versioning. Trigger on: CI/CD, pipeline, deployment, infrastructure, DevOps.
---

# CI/CD Pipeline and Deployment Skill

## OVERVIEW

This skill covers the end-to-end continuous integration and continuous delivery lifecycle: designing build/test/deploy pipelines, configuring deployment strategies (blue-green, canary, rolling), maintaining environment parity across dev/staging/prod, implementing rollback procedures, establishing health checks and monitoring, managing secrets securely, and versioning artifacts reliably. Scope is limited to pipeline definitions, deployment configurations, infrastructure-as-code tooling, and DevOps automation — not application code or runtime service logic.

## CONVENTIONS

- Detect the existing CI/CD platform (GitHub Actions, GitLab CI, Jenkins, Azure DevOps, etc.) before introducing new pipeline syntax. Follow the project's native DSL and stage naming conventions.
- Pipeline stages must follow a strict linear dependency: source checkout → dependency resolution → lint/static analysis → unit tests → build → integration tests → security scan → artifact packaging → deploy to target environment. No stage may be skipped in production pipelines; dev pipelines may allow selective bypass with explicit opt-in flags.
- Environment configurations (dev, staging, prod) must be managed through parameterized pipeline inputs or environment-specific configuration files, never hardcoded into the pipeline definition. Maintain structural parity: the same pipeline runs against all environments with only configuration differences.
- Deployment strategies must be selected based on service criticality and downtime tolerance. Blue-green for zero-downtime full swaps, canary for gradual traffic shifting with automated rollback thresholds, rolling for stateless services where partial availability is acceptable.
- Secrets must never appear in pipeline definitions, logs, or artifact metadata. Use the platform's native secrets store (e.g., GitHub Actions secrets, HashiCorp Vault, AWS Secrets Manager) and inject at runtime via environment variables or mounted files with restricted permissions.
- Artifacts must be versioned using immutable identifiers: semantic versions for releases, commit SHAs for builds, and content-addressable hashes where supported. Artifact retention policies must be defined per environment to control storage costs.
- Health checks must be implemented at both the infrastructure level (port probes, DNS resolution) and the application level (readiness and liveness endpoints). Deployment gates must verify health before proceeding to the next stage or marking a deployment as successful.

## CHECKLIST

- [ ] Pipeline stages are ordered correctly: checkout → deps → lint → unit tests → build → integration tests → security scan → package → deploy
- [ ] No secrets are hardcoded in pipeline definitions, scripts, or configuration files
- [ ] Environment configurations are parameterized and structurally identical across dev/staging/prod
- [ ] Deployment strategy matches service criticality (blue-green for zero-downtime, canary for gradual rollout, rolling for stateless)
- [ ] Rollback procedure is defined, tested, and automated — not manual-only
- [ ] Health checks exist at infrastructure level (port/DNS) and application level (readiness/liveness endpoints)
- [ ] Deployment gates verify health before marking deployment successful or proceeding to next stage
- [ ] Artifacts are versioned with immutable identifiers (semver for releases, commit SHA for builds)
- [ ] Artifact retention policies are defined per environment
- [ ] Pipeline logs redact sensitive data and do not expose secrets in output
- [ ] Security scanning (SAST, SCA, container image scan) is integrated into the pipeline before deployment
- [ ] Pipeline failure notifications are configured with appropriate channels and severity routing
- [ ] Infrastructure changes are version-controlled alongside pipeline definitions (IaC as code)
- [ ] Pipeline execution times are monitored and optimized; slow stages are identified and addressed

## PATTERNS

### Pipeline Stage Design

Structure pipelines as composable, independently testable stages. Each stage produces verifiable output consumed by the next stage.

```yaml
# Example: GitHub Actions pipeline structure
stages:
  - name: build
    steps: [checkout, cache-deps, install, lint, unit-test, compile]
    artifacts: [build-output.tar.gz]
  - name: test
    needs: [build]
    steps: [restore-artifacts, integration-test, e2e-test]
    reports: [test-results.xml, coverage.json]
  - name: security
    needs: [build]
    steps: [sast-scan, sca-audit, container-scan]
    gates: [vulnerability-threshold]
  - name: deploy-staging
    needs: [test, security]
    steps: [package, push-registry, deploy, smoke-test, health-check]
  - name: deploy-production
    needs: [deploy-staging]
    steps: [promote-artifact, deploy, health-check, notify]
```

### Blue-Green Deployment

Maintain two identical production environments. Route all traffic to the active environment (blue). Deploy to the inactive environment (green). Validate green with smoke tests and health checks. Switch traffic atomically. Rollback by switching traffic back to blue.

```yaml
strategy:
  type: blue-green
  active: blue
  inactive: green
  switch:
    method: load-balancer-update
    verification: [smoke-tests, health-endpoints]
  rollback:
    trigger: health-check-failure | manual-approval-timeout
    action: revert-traffic-to-active
```

### Canary Deployment

Deploy to a small subset of instances or route a percentage of traffic to the new version. Monitor error rates, latency, and business metrics against defined thresholds. Automatically promote or rollback based on observed behavior.

```yaml
strategy:
  type: canary
  steps:
    - traffic: 5%
      duration: 10m
      thresholds: { error_rate: <0.1%, p99_latency: <200ms }
    - traffic: 25%
      duration: 15m
      thresholds: { error_rate: <0.1%, p99_latency: <200ms }
    - traffic: 50%
      duration: 15m
      thresholds: { error_rate: <0.1%, p99_latency: <200ms }
    - traffic: 100%
  rollback:
    trigger: threshold-breach | manual-intervention
    action: revert-to-previous-version
```

### Secrets Management

Inject secrets at runtime from a dedicated secrets manager. Never store secrets in version control, pipeline definitions, or build artifacts.

```yaml
# Pipeline references secrets by name; values resolved at runtime
env:
  DATABASE_URL: \${{ secrets.DATABASE_URL }}
  API_KEY: \${{ secrets.API_KEY }}
  TLS_CERT: \${{ secrets.TLS_CERT_BUNDLE }}

# Secrets rotation policy
secrets-policy:
  rotation-interval: 90d
  pre-rotation-test: true # validate new secret works before revoking old
  audit-log: true # log all secret access with caller identity
```

### Artifact Versioning and Retention

Version artifacts immutably and enforce retention policies to balance traceability with storage costs.

```yaml
artifact-versioning:
  release-pattern: "{service}-{semver}-{sha-short}"
  build-pattern: "{service}-{branch}-{sha-full}-{timestamp}"
  immutability: true # once published, artifact cannot be overwritten

retention:
  dev: 7d
  staging: 30d
  production: 365d
  release-artifacts: indefinite
```

### Health Check and Monitoring Gates

Block deployment progression until health checks pass. Define both infrastructure-level and application-level probes.

```yaml
health-gates:
  infrastructure:
    - type: tcp-port
      target: ":8080"
      timeout: 5s
      retries: 3
    - type: dns-resolution
      target: "api.example.com"
      timeout: 10s
  application:
    - type: http-get
      path: "/health/ready"
      expected-status: 200
      timeout: 10s
      interval: 5s
      success-threshold: 3
    - type: http-get
      path: "/health/live"
      expected-status: 200
      timeout: 5s
  deployment-gate:
    require-all-pass: true
    fail-action: rollback
```

## CONSTRAINTS

- Do not hardcode secrets, credentials, or tokens in pipeline definitions, scripts, or configuration files under any circumstances.
- Do not skip security scanning stages in production pipelines. Dev pipelines may allow opt-out with explicit, documented justification.
- Do not deploy directly to production without an intermediate staging environment that mirrors production configuration.
- Do not use mutable artifact identifiers (e.g., `latest` tags) in production deployment configurations. Use immutable versioned references only.
- Do not implement rollback as a manual-only process. Rollback must be automated and triggerable from pipeline failure conditions.
- Do not store environment-specific secrets in shared configuration files. Each environment must have isolated secret scopes.
- Do not allow pipeline definitions to execute arbitrary code from untrusted sources without explicit security review and approval gates.
- Do not conflate CI (build/test) and CD (deploy) concerns into a single monolithic pipeline file. Separate them into composable, independently maintainable configurations.
