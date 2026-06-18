---
name: backend-skill
description: Backend API and service development skill covering REST/GraphQL/gRPC design, business logic architecture, authentication patterns, error handling, server-side validation, and middleware. Trigger on: backend, API, service, business logic, server-side.
---

# Backend Skill

## OVERVIEW

Covers all aspects of server-side application development including API design (REST, GraphQL, gRPC), business logic layering, authentication and authorization patterns, error handling strategies, input validation, middleware pipelines, and service communication. Scope is bounded to backend source code, configuration, and API contracts; does not cover infrastructure provisioning, CI/CD pipeline definitions, or frontend implementation.

## CONVENTIONS

- Detect the project's framework (Express, Fastify, NestJS, Spring Boot, ASP.NET, Django, FastAPI, Go chi, etc.) before applying patterns. Never assume a framework or language.
- API endpoints follow resource-oriented naming for REST (`/resources/{id}`), operation-based naming for GraphQL mutations, and protobuf service definitions for gRPC. Maintain consistency within the project's chosen paradigm.
- Business logic must be isolated from transport layer (routes/controllers). Controllers handle request parsing and response formatting; services contain domain rules; repositories handle data access.
- Authentication follows the project's existing scheme (JWT, OAuth2, API keys, session cookies). Never introduce a new auth mechanism without architectural review.
- All inputs are untrusted. Validate at the boundary (request body, query params, path params, headers) before any business logic executes. Use schema validators matching the project convention (Zod, Joi, class-validator, Pydantic, etc.).
- Error responses follow a consistent envelope: `{ "error": { "code": string, "message": string, "details?: object } }`. HTTP status codes must accurately reflect the error category (4xx client, 5xx server).
- Middleware is ordered: logging -> auth -> validation -> business logic -> response serialization. Each middleware has a single responsibility.
- Logging uses structured format with correlation IDs for request tracing. Never log sensitive data (passwords, tokens, PII).

## CHECKLIST

- [ ] API endpoint follows project naming convention (resource-oriented for REST, operation-based for GraphQL)
- [ ] Request/response schemas defined and validated at the transport boundary before business logic
- [ ] Business logic isolated in service layer — no domain rules in controllers or route handlers
- [ ] Data access abstracted behind repository/interface layer — no raw queries in services
- [ ] Authentication middleware applied to all protected endpoints with proper role/permission checks
- [ ] Error responses use consistent envelope format with appropriate HTTP status codes
- [ ] Input validation rejects malformed data before it reaches business logic (fail-fast)
- [ ] Structured logging includes correlation ID, endpoint, method, and duration — excludes sensitive fields
- [ ] Rate limiting applied to public-facing endpoints and mutation operations
- [ ] Pagination implemented for list endpoints (cursor-based preferred for large datasets)
- [ ] Idempotency keys supported on non-idempotent operations (POST, custom mutations)
- [ ] API versioning strategy applied if breaking changes are introduced
- [ ] Health check endpoint (`/health`) returns service status and dependency connectivity
- [ ] Integration tests cover all endpoints with representative payloads and error conditions

## PATTERNS

### Layered Architecture (Controller -> Service -> Repository)

Separate concerns across layers. Controllers parse requests and format responses. Services enforce business rules. Repositories abstract data access.

```
POST /orders
  └─ OrderController.create()     ← parses request, validates input, formats response
       └─ OrderService.placeOrder() ← enforces business rules (inventory, pricing, limits)
            ├─ InventoryRepository.check()
            ├─ PricingService.calculate()
            └─ OrderRepository.save()
```

### Consistent Error Envelope

All API errors return a uniform structure enabling clients to handle failures programmatically.

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request body validation failed",
    "details": [
      { "field": "email", "issue": "Invalid email format" },
      { "field": "age", "issue": "Must be between 18 and 120" }
    ]
  }
}
```

### Repository Pattern with Interface Abstraction

Define data access through interfaces. Implementations can swap between ORM, raw SQL, or external APIs without affecting service layer code.

```typescript
interface UserRepository {
  findById(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  save(user: User): Promise<void>;
}
```

### Middleware Pipeline Ordering

Middleware executes in a defined sequence. Each stage has a single responsibility and can short-circuit the pipeline on failure.

```
Request → Logging → Auth → RateLimit → Validation → Handler → Serialization → Response
```

### Idempotency for Safe Retries

Non-idempotent operations accept an idempotency key header. Duplicate requests with the same key return the original response without re-executing business logic.

```
POST /charges
Idempotency-Key: uuid-v4-unique-per-client-request
```

## CONSTRAINTS

- Do not modify CI/CD pipeline definitions, Dockerfiles, or infrastructure-as-code files.
- Do not introduce a new authentication mechanism without explicit architectural review.
- Do not place business logic in controllers, route handlers, or middleware — keep it in the service layer.
- Do not log sensitive data: passwords, tokens, API keys, PII, or full request/response bodies containing secrets.
- Do not return internal error details (stack traces, query strings, file paths) in production error responses.
- Do not use raw SQL queries in service or controller layers — route all data access through the repository abstraction.
- Do not couple API contracts to internal data models — define explicit DTOs for all input and output boundaries.
