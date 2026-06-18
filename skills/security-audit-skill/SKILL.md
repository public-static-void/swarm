---
name: security-audit-skill
description: Security audit and vulnerability detection skill covering OWASP Top 10, compliance frameworks, risk scoring, dependency auditing, secrets detection, and secure configuration — trigger on: security, audit, vulnerability, compliance, OWASP.
---

# Security Audit Skill

## OVERVIEW

This skill provides a structured methodology for conducting comprehensive security audits of codebases, configurations, and dependencies. It covers OWASP Top 10 vulnerability detection, compliance framework alignment (SOC2, GDPR, HIPAA), CVSS-based risk scoring, dependency auditing, secrets detection, and secure configuration validation. The scope includes application-layer security, infrastructure-as-code review, and third-party component assessment. It does not cover penetration testing, red teaming, or hardware-level security analysis.

## CONVENTIONS

- Detect the project's existing security tooling (SAST/DAST scanners, dependency managers, secret management) before introducing new patterns.
- Apply OWASP Top 10 (2021 edition) as the baseline vulnerability taxonomy unless the project uses a different framework.
- Use CVSS v3.1 or v4.0 for risk scoring; default to v3.1 if version is unspecified.
- Classify findings using four severity tiers: Critical (9.0–10.0), High (7.0–8.9), Medium (4.0–6.9), Low (0.1–3.9).
- Report findings with: vulnerability type, affected location, CVSS score, severity tier, evidence snippet, and remediation guidance.
- Detect project-specific secrets management (e.g., HashiCorp Vault, AWS Secrets Manager, environment variables) before flagging patterns as exposed secrets.

## CHECKLIST

- [ ] **A01:2021 — Injection**: Scan for unsanitized user input in SQL queries, OS commands, LDAP filters, ORM raw queries, and template engines. Verify parameterized queries or prepared statements are used universally.
- [ ] **A02:2021 — Broken Authentication**: Verify session management (secure flags, rotation, timeout), password hashing (bcrypt/scrypt/argon2, not MD5/SHA1), MFA enforcement where required, and credential storage practices.
- [ ] **A03:2021 — Sensitive Data Exposure**: Check for plaintext storage of PII, credentials, or tokens. Verify TLS enforcement, encryption at rest, proper CORS policies, and HSTS headers. Audit data minimization in logs and error responses.
- [ ] **A04:2021 — Insecure Design**: Review architecture for missing security controls, inadequate threat modeling, and business logic flaws (e.g., race conditions, privilege escalation paths).
- [ ] **A05:2021 — Security Misconfiguration**: Audit default credentials, verbose error messages, unnecessary services/ports, permissive CORS, missing security headers (CSP, X-Frame-Options, X-Content-Type-Options), and debug modes in production.
- [ ] **A06:2021 — Vulnerable and Outdated Components**: Run dependency audits against known vulnerability databases (NVD, OSV). Check for unmaintained packages, deprecated versions, and transitive dependency risks.
- [ ] **A07:2021 — Identification and Authentication Failures**: Verify token validation (JWT signature verification, expiration checks), OAuth/OIDC flow correctness, brute-force protections, and account lockout policies.
- [ ] **A08:2021 — Software and Data Integrity Failures**: Check CI/CD pipeline integrity (signed commits, verified artifacts), deserialization safety (reject untrusted input, use allowlists), and update mechanisms for tamper resistance.
- [ ] **A09:2021 — Security Logging and Monitoring Failures**: Verify comprehensive audit logging for authentication events, authorization failures, data access, and configuration changes. Check log integrity, retention policies, and alerting thresholds.
- [ ] **A10:2021 — Server-Side Request Forgery (SSRF)**: Scan for unvalidated URL inputs in server-side fetch operations. Verify allowlists, DNS rebinding protections, and internal network isolation.
- [ ] **XXE Detection**: Check XML parsers for external entity processing, DTD loading, and schema validation bypasses. Ensure libxml2, SAX, and DOM parsers are configured securely.
- [ ] **Cross-Site Scripting (XSS)**: Verify output encoding/escaping in HTML, JavaScript, CSS, and URL contexts. Check Content-Security-Policy headers and HTTPOnly/Secure cookie flags.
- [ ] **Insecure Deserialization**: Audit deserialization of user-controlled data (JSON, YAML, pickle, Java objects). Verify type restrictions, allowlists, and safe parsing libraries.
- [ ] **Broken Access Control**: Verify authorization checks at every access point (not just UI-level). Check for IDOR vulnerabilities, horizontal/vertical privilege escalation paths, and missing object-level permissions.
- [ ] **Compliance — SOC2**: Verify access controls, change management procedures, incident response plans, and audit trail completeness against SOC2 Trust Service Criteria.
- [ ] **Compliance — GDPR**: Check data processing lawfulness, consent mechanisms, data subject rights implementation (access, rectification, erasure), data breach notification procedures, and cross-border transfer safeguards.
- [ ] **Compliance — HIPAA**: Verify PHI handling controls, access logging, encryption requirements, business associate agreements, and minimum necessary data access principles.
- [ ] **Dependency Audit**: Run automated scans (npm audit, pip-audit, cargo audit, dotnet list package --vulnerable). Review transitive dependencies, license compliance, and supply chain integrity (SBOM generation).
- [ ] **Secrets Detection**: Scan for hardcoded credentials, API keys, private keys, tokens, and connection strings in source code, configuration files, Dockerfiles, and commit history. Verify use of dedicated secret management solutions.
- [ ] **Secure Configuration**: Audit environment-specific configurations for debug flags, verbose logging, permissive file permissions, unnecessary dependencies, and default settings that weaken security posture.

## PATTERNS

### CVSS-Based Risk Scoring

Assign severity using CVSS v3.1 vector strings. Example:

```
AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H  →  Score: 10.0  →  Critical
AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N  →  Score: 7.5   →  High
AV:L/AC:H/PR:H/UI:R/S:U/C:L/I:L/A:N →  Score: 2.7    →  Low
```

Prioritize remediation by: Critical (immediate), High (within sprint), Medium (next release), Low (backlog).

### Injection Detection Pattern

Scan for string concatenation or interpolation in data-access contexts:

```
# Vulnerable — string concatenation in SQL
query = "SELECT * FROM users WHERE id = " + user_input

# Secure — parameterized query
cursor.execute("SELECT * FROM users WHERE id = %s", (user_input,))
```

Apply the same principle to OS commands, LDAP queries, NoSQL queries, and template rendering.

### Secrets Detection Pattern

Search for high-entropy strings matching known secret formats:

- AWS keys: `AKIA[0-9A-Z]{16}`
- Private keys: `-----BEGIN (RSA |EC |DSA )?PRIVATE KEY-----`
- Generic API tokens: hex strings of 32+ characters assigned to variables named `key`, `secret`, `token`, `password`
- Connection strings with embedded credentials in source files

### Dependency Audit Pattern

Maintain a Software Bill of Materials (SBOM) and automate vulnerability scanning in CI:

```
# Example CI step
npm audit --json > audit-report.json
pip-audit --format json > pip-audit-report.json
```

Cross-reference findings with NVD CVE database and project-specific allowlists for accepted risks.

### Secure Configuration Checklist Pattern

Validate configuration against a security baseline:

- Disable debug/verbose modes in production
- Enforce HTTPS-only with HSTS (min 1 year max-age)
- Set restrictive CORS origins (no wildcards in production)
- Enable security headers: CSP, X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy strict-origin-when-cross-origin
- Remove default accounts and sample data before deployment

## CONSTRAINTS

- Do NOT perform active exploitation, penetration testing, or any action that could disrupt production systems. This skill is for static analysis and configuration review only.
- Do NOT store or transmit detected secrets in audit reports. Redact sensitive values and reference their location instead.
- Do NOT introduce security tooling that conflicts with the project's existing CI/CD pipeline without explicit approval. Flag gaps rather than mandate specific tools.
- Do NOT assess hardware security, physical access controls, or network infrastructure beyond application-layer configuration.
- Do NOT provide legal compliance opinions. Compliance checks are technical gap analyses only; engage qualified legal counsel for regulatory interpretation.
- Do NOT flag false positives from test fixtures, example code, or intentionally insecure demonstration modules without noting their context.
