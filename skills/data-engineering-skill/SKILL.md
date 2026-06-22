---
name: data-engineering-skill
description: Data engineering skill covering schema design, migration strategies, query optimization, indexing, data access layers, and fixture generation. Trigger on: database, schema, migration, query, data model.
---

# Data Engineering Skill

## OVERVIEW

Covers all aspects of data layer development including relational and NoSQL schema design, migration strategy and lifecycle management, query performance optimization, indexing strategies, data access layer patterns, and test fixture generation. Scope is bounded to database schemas, migrations, queries, and data access code; does not cover infrastructure provisioning, backup/restore procedures, or data warehouse architecture.

## CONVENTIONS

- Detect the project's database technology (PostgreSQL, MySQL, SQLite, MongoDB, Redis, etc.) and ORM/query builder (Prisma, TypeORM, Sequelize, SQLAlchemy, Mongoose, raw SQL) before applying patterns.
- Schema naming follows the project convention: tables use plural snake_case (`user_orders`), columns use singular snake_case (`created_at`), primary keys are `id` (auto-incrementing integer or UUID), foreign keys follow `{referenced_table}_id`.
- Include `created_at` and `updated_at` timestamps on all tables; omit only with documented justification.
- Migrations are versioned, reversible, and idempotent. Each migration has a forward and backward operation.
- Indexes are created based on actual query patterns, not speculation. Composite indexes follow the leftmost-prefix principle with equality columns before range columns.
- Data access is abstracted behind repository interfaces or ORM models. Raw queries are confined to dedicated query files with clear documentation of their purpose and performance characteristics.
- NULL handling is explicit: every column is declared `NULL` or `NOT NULL` with a default value if nullable. Use `NOT NULL` on columns that are indexed or used in JOIN conditions.
- Test fixtures use seed scripts that are deterministic, idempotent, and scoped to the minimum data required for each test scenario.

## CHECKLIST

- [ ] Schema follows project naming conventions (table/column naming, key patterns)
- [ ] All tables have primary keys and appropriate foreign key constraints with cascading rules defined
- [ ] Timestamp columns (`created_at`, `updated_at`) present unless explicitly excluded with justification
- [ ] Column nullability is explicit — no implicit NULL defaults on columns that should be NOT NULL
- [ ] Indexes align with actual query patterns (verified via EXPLAIN/EXPLAIN ANALYZE)
- [ ] Composite indexes ordered correctly: equality columns first, then range/sort columns
- [ ] Migrations are versioned, reversible, and idempotent — no modifications to applied migrations
- [ ] Data access abstracted behind repository interfaces or ORM models — no raw queries in business logic
- [ ] N+1 query problems identified and resolved (eager loading, batching, or denormalization where appropriate)
- [ ] Large result sets use pagination (offset/limit or cursor-based) — always limit result sets with pagination
- [ ] Test fixtures are deterministic, idempotent, and contain only the minimum required data
- [ ] Sensitive data columns are encrypted at rest if they contain PII or secrets
- [ ] Connection pooling configured appropriately for the expected concurrency level

## PATTERNS

### Migration Lifecycle

Migrations follow a strict lifecycle: create -> review -> apply to development -> test -> apply to staging -> deploy to production. Rollback procedures are tested before deployment.

```sql
-- Migration: 0012_add_user_preferences.up.sql
CREATE TABLE user_preferences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key VARCHAR(100) NOT NULL,
    value JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id, key)
);

CREATE INDEX idx_user_preferences_user_id ON user_preferences(user_id);
```

### Repository Pattern for Data Access

Abstract data access behind typed interfaces. Business logic depends on the interface, not the implementation.

```typescript
interface OrderRepository {
  findById(id: string): Promise<Order | null>;
  findByCustomerId(customerId: string, status?: OrderStatus): Promise<Order[]>;
  save(order: Order): Promise<void>;
  deleteById(id: string): Promise<boolean>;
}
```

### Index Design by Query Pattern

Create indexes that match the WHERE, JOIN, and ORDER BY clauses of actual queries. Use EXPLAIN ANALYZE to verify index usage before and after creation.

```sql
-- Query: SELECT * FROM orders WHERE customer_id = ? AND status = 'pending' ORDER BY created_at DESC
-- Index covers equality (customer_id, status) then range sort (created_at DESC)
CREATE INDEX idx_orders_customer_status_created
  ON orders(customer_id, status, created_at DESC);
```

### N+1 Query Resolution

Detect and eliminate N+1 queries through eager loading, batch fetching, or strategic denormalization. Profile before optimizing.

```typescript
// Bad: N+1 — loads customers separately for each order
const orders = await Order.findAll();
for (const order of orders) {
  order.customer = await Customer.findByPk(order.customerId);
}

// Good: single query with join
const orders = await Order.findAll({
  include: [{ model: Customer, attributes: ["id", "name"] }],
});
```

### Deterministic Test Fixtures

Seed data is generated deterministically so tests produce identical results across runs. Use factories or builders for complex object graphs.

```typescript
// Factory pattern — generates consistent test data
const seedUser = (overrides?: Partial<User>) => ({
  id: "test-user-001",
  email: "test@example.com",
  name: "Test User",
  createdAt: new Date("2024-01-01T00:00:00Z"),
  ...overrides,
});
```

## CONSTRAINTS

- Create a new migration for every schema change.
- Add indexes only after verifying their benefit through query plan analysis (EXPLAIN).
- Confine raw SQL to repository implementations or dedicated query modules.
- Always apply pagination or limiting on list queries.
- Encrypt or hash sensitive data before storage.
- Abstract database-specific features behind an interface layer.
- Drop columns or tables only after a deprecation migration phase.
