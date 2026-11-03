## ADDED Requirements

### Requirement: Agreement is claimed only for compared operations

`audit` and the map SHALL report a service as agreeing only when at least one of its declared operations was compared against its contract and no disagreement was found.

#### Scenario: No operation was compared

- **WHEN** the server responds but no declared operation was compared, such as a contract with only templated routes and no route to sample identifiers from
- **THEN** the state says nothing was compared and does not contain "agrees"

#### Scenario: Every declared operation agrees

- **WHEN** every declared operation was compared and no disagreement was found
- **THEN** the state reports agreement

#### Scenario: A disagreement is found

- **WHEN** a compared response is missing a required field or has a wrong type
- **THEN** the state reports the number of disagreements and each one is listed

### Requirement: Partial coverage is stated

`audit` and the map SHALL state how many declared operations were compared whenever that is fewer than all of them.

#### Scenario: Some operations were compared

- **WHEN** one of two declared operations was compared and it agreed
- **THEN** the state shows agreement qualified as 1 of 2 compared

### Requirement: All outputs state the same result

The terminal and HTML outputs SHALL derive the state from one shared computation, and `audit --json` SHALL keep reporting `operations_probed`.

#### Scenario: Same audit rendered in each format

- **WHEN** one audit result is rendered as terminal text and as HTML
- **THEN** both state the same coverage and the same agreement result
