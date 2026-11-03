## ADDED Requirements

### Requirement: CI exercises every platform listed as supported

CI SHALL run the safety suite on Linux and macOS for each supported Node major version.

#### Scenario: Pull request is opened

- **WHEN** CI runs its safety job or its scheduled qualification
- **THEN** results exist for Linux and macOS on Node 22 and 24, within the cadence the maintainers set for each

### Requirement: The full suite runs on a schedule

The product regression suite SHALL run on a schedule in addition to release gates, and its summary SHALL name every skip.

#### Scenario: Scheduled run has skips

- **WHEN** the scheduled run completes with skipped tests
- **THEN** its summary lists each skipped test with its reason

#### Scenario: Scheduled run fails

- **WHEN** a test fails on the scheduled run
- **THEN** the run is reported as failed

### Requirement: Public checkouts contain no references to absent tooling

The test runner and regression tests in the public tree SHALL NOT depend on private commands or services without naming the missing prerequisite in a skip.

#### Scenario: Contributor runs the full suite

- **WHEN** a contributor runs `npm run test:full` from a public checkout
- **THEN** every skip names a prerequisite that the contributor can identify
