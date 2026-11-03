## ADDED Requirements

### Requirement: Requests report schema disagreement

When a response matches an operation in the stack's bound contract, `request` and `api_request` SHALL report any disagreement with the declared response schema in `contract_delta`.

#### Scenario: Required field is missing

- **WHEN** the contract requires `must_exist` and the response omits it
- **THEN** `contract_delta` contains a `schema-mismatch` item naming `must_exist`

#### Scenario: Field has the wrong type

- **WHEN** the contract declares `id` as an integer and the response has a string
- **THEN** `contract_delta` contains a `schema-mismatch` item naming `id` and both types

#### Scenario: Response conforms

- **WHEN** the response conforms to the declared schema
- **THEN** no `schema-mismatch` item is reported

### Requirement: Schema disagreement does not change ok

A `schema-mismatch` item SHALL NOT by itself change `ok`, which continues to reflect the caller's assertions or, without assertions, HTTP success.

#### Scenario: Mismatch with a passing assertion

- **WHEN** the caller's status assertion passes and the response has a `schema-mismatch`
- **THEN** `ok` is true and `contract_delta` reports the mismatch

### Requirement: Only names and types are reported

A `schema-mismatch` item SHALL contain field names and types and MUST NOT contain response values.

#### Scenario: Mismatched field holds a sensitive value

- **WHEN** a mismatched field contains a credential-shaped string
- **THEN** that string appears in neither the item nor any committed file

### Requirement: Unevaluated schema is not reported as passing

The result MUST state when a schema construct could not be evaluated rather than treating it as conforming.

#### Scenario: Unsupported composed schema

- **WHEN** the declared schema uses a construct the comparison cannot evaluate
- **THEN** the result names it as not checked and reports no conformance for it

### Requirement: Reporting stays within the response budget

Schema mismatch reporting SHALL be bounded, count toward the existing response budget, and state how many items were omitted.

#### Scenario: Many fields disagree

- **WHEN** more fields disagree than the bound allows
- **THEN** the result stays within budget and reports the number omitted
