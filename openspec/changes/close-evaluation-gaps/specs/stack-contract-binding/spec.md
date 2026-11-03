## ADDED Requirements

### Requirement: Contract source is recorded

`stack add --contract` SHALL record the source path and digest of the contract it copies in `stack.json`, and stacks without that record SHALL continue to load.

#### Scenario: Stack is created from a contract

- **WHEN** a stack is added with a project-local contract
- **THEN** `stack.json` records its source path and digest

#### Scenario: Existing stack has no source record

- **WHEN** a stack created by an earlier version is loaded
- **THEN** it loads normally and `doctor` says staleness could not be checked

### Requirement: A stale contract copy is reported

`doctor` SHALL warn when the recorded source differs from the stack's copy, name both paths, and SHALL NOT replace the copy automatically.

#### Scenario: Source was edited

- **WHEN** the source contract changes after the stack was created
- **THEN** `doctor` warns and the stack's copy is unchanged

#### Scenario: Source was removed

- **WHEN** the recorded source no longer exists
- **THEN** `doctor` says the source is missing and does not report the contract as current

### Requirement: Audit uses the bound contract

`audit --stack <name>` SHALL audit the contract bound to that stack, whatever the file is named.

#### Scenario: Contract has an unconventional filename

- **WHEN** a stack's contract was added from a file named `o1.yaml`
- **THEN** `audit --stack` audits it and does not return `NO_API_FOUND`
