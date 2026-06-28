---
name: testing-skill
description: Testing strategy skill covering unit, integration, and acceptance test design, coverage goals, test data patterns, mocking/stubbing strategies, TDD workflows, and edge case identification. Trigger on: test, QA, coverage, TDD, integration test.
---

# Testing Skill

## OVERVIEW

Covers comprehensive testing strategy across all levels of the test pyramid: unit tests for isolated logic, integration tests for component interaction, and acceptance tests for end-to-end behavior. Includes coverage target definition, test data management, mocking and stubbing strategies, Test-Driven Development workflows, and systematic edge case identification. Scope bounded to test code, test configuration, and test infrastructure.

## CONVENTIONS

- Detect the project's test framework (Jest, Vitest, Mocha, Pytest, JUnit, Go testing, etc.) and assertion library before applying patterns.
- Test pyramid ratio guideline: 70% unit tests, 20% integration tests, 10% acceptance/e2e tests. Adjust based on project risk profile but maintain the principle that most tests are fast and isolated.
- Tests follow the Arrange-Act-Assert (AAA) structure. Each test has a single assertion focus — one behavioral expectation per test case.
- Test names describe the behavior being verified — e.g., `should_reject_negative_quantity()`.
- Test data is isolated per test. Each test uses isolated data via factories, builders, or fixtures that produce fresh data for each test execution.
- Mocks simulate external dependencies (HTTP clients, databases, file systems, message queues). Stubs provide fixed return values for internal collaborators. Prefer stubs over mocks when the implementation detail of the collaborator is irrelevant.
- Coverage targets: 80%+ line coverage for business logic modules, 60%+ for infrastructure/glue code. Coverage is a minimum threshold; meaningful assertions take priority over meeting arbitrary percentages.
- TDD workflow: write a failing test that describes the desired behavior -> implement the minimal code to pass -> refactor while keeping tests green. Write a failing test before implementing production code in TDD mode.

## CHECKLIST

- [ ] Tests follow Arrange-Act-Assert structure with clear separation of setup, execution, and verification
- [ ] Each test verifies a single behavioral expectation
- [ ] Test names describe the behavior under test
- [ ] Test data is isolated per test execution
- [ ] External dependencies (HTTP, DB, FS, queues) are mocked or stubbed in unit tests
- [ ] Integration tests verify real component interaction with controlled test databases or containers
- [ ] Acceptance tests cover critical user journeys without mocking the application under test
- [ ] Edge cases covered: empty inputs, null/undefined values, boundary values, overflow, concurrent access
- [ ] Negative test cases verify proper error handling and rejection of invalid inputs
- [ ] Test coverage meets minimum thresholds (80% business logic, 60% infrastructure)
- [ ] Tests are deterministic — identical results across runs without flaky timing dependencies
- [ ] Slow tests (>1s) are identified and either optimized or marked for separate execution profiles
- [ ] Test cleanup (teardown) ensures no residual state affects subsequent test execution

## PATTERNS

### Arrange-Act-Assert Structure

Every test follows a three-phase structure that separates setup, execution, and verification.

```typescript
describe("OrderService.placeOrder", () => {
  it("should reject orders with zero quantity", async () => {
    // Arrange
    const service = new OrderService(repository, inventoryService);
    const order = {
      customerId: "c1",
      items: [{ productId: "p1", quantity: 0 }],
    };

    // Act
    const result = await service.placeOrder(order);

    // Assert
    expect(result).toEqual({ success: false, error: "INVALID_QUANTITY" });
  });
});
```

### Test Data with Factories

Factories produce consistent, customizable test data without boilerplate duplication.

```typescript
const createOrder = (overrides?: Partial<Order>) => ({
  id: "order-001",
  customerId: "customer-001",
  items: [{ productId: "prod-001", quantity: 1, price: 29.99 }],
  status: "pending",
  createdAt: new Date("2024-01-01T00:00:00Z"),
  ...overrides,
});

// Usage with customization
const orderWithZeroQty = createOrder({
  items: [{ productId: "prod-001", quantity: 0, price: 29.99 }],
});
```

### Mock vs Stub Selection

Use stubs when you only need a fixed return value. Use mocks when you need to verify interaction patterns (call count, arguments).

```typescript
// Stub — we only care about the return value
const inventoryStub = { checkAvailability: () => Promise.resolve(true) };

// Mock — we need to verify the service called it with correct arguments
const repoMock = { save: jest.fn().mockResolvedValue(undefined) };
await service.placeOrder(order);
expect(repoMock.save).toHaveBeenCalledWith(expectedOrder);
```

### Edge Case Matrix

Systematically identify edge cases by varying input dimensions.

| Input Dimension | Normal  | Boundary  | Invalid         | Empty |
| --------------- | ------- | --------- | --------------- | ----- |
| Quantity        | 5       | 1, 999999 | -1, 0           | N/A   |
| Items array     | [item]  | []        | null, undefined | []    |
| Customer ID     | "c-001" | ""        | null, -1        | ""    |

### TDD Red-Green-Refactor Cycle

1. **Red**: Write a test that describes the desired behavior. Watch it fail.
2. **Green**: Write the minimal production code to make the test pass. No over-engineering.
3. **Refactor**: Improve both test and production code while keeping all tests green.

## CONSTRAINTS

- Test observable behavior through public APIs exclusively.
- Mock or stub all external services in unit tests.
- Keep each test independently executable with isolated mutable state.
- Include negative test cases for every code path.
- Use coverage as a minimum threshold; measure quality by assertion meaningfulness.
- Write deterministic tests with seeded random data and explicit timing control.
- Test only your integration with third-party libraries.
