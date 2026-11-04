# Data model — Phase 1 draft

Status: **draft**. Nothing here is implemented yet; PostgreSQL + Drizzle arrive in Phase 1. This fixes names and ownership boundaries before gameplay code exists. Revise in the ticket that implements each table.

## Principles
- **Content is code, state is data.** Classes, enemies, areas, item bases, affixes and loot tables are versioned definitions in `@worldforge/game-core`, referenced from the database by string id (`class_id = 'warrior'`). The database stores only player and world *state*.
- **Server-authoritative.** Every row below is written only by the server. Values derived from content (final stats, power score) are computed, not stored, unless needed for leaderboards.
- **Integers for value.** Gold and other currencies are `bigint`; no floats for anything that is spent or compared.
- **Auditability.** Value-changing operations write a ledger/audit row in the same transaction.
- IDs are UUIDv7 (`uuid`), timestamps `timestamptz` in UTC. Soft deletes only where noted.

## Entities

### account
| Column       | Type        | Notes                                    |
| ------------ | ----------- | ---------------------------------------- |
| id           | uuid PK     |                                          |
| display_name | text        | unique, case-insensitive                 |
| auth_kind    | text        | `dev` (Phase 1 dev identity) or `password`/`oauth` later |
| character_slots | smallint | default 2 (GDD §5.3)                    |
| created_at   | timestamptz |                                          |

Credentials live in a separate `account_credential` table so the dev identity never shares storage with real auth.

### session
`id` (random 256-bit token hash, PK), `account_id` FK, `created_at`, `expires_at`, `revoked_at`. Only the hash is stored.

### character
| Column         | Type        | Notes                                            |
| -------------- | ----------- | ------------------------------------------------ |
| id             | uuid PK     |                                                  |
| account_id     | uuid FK     | indexed; count ≤ `account.character_slots`       |
| name           | text        | unique                                           |
| class_id       | text        | game-core `ClassId`, immutable after creation    |
| appearance     | jsonb       | cosmetic choices (GDD §5.1)                      |
| level          | integer     |                                                  |
| experience     | bigint      | within current level                             |
| gold           | bigint      | `CHECK (gold >= 0)`                              |
| rng_state      | bigint      | persisted seeded-RNG state for reproducible rolls |
| version        | integer     | optimistic concurrency counter                   |
| created_at / updated_at | timestamptz |                                         |

Gold is per character in Phase 1; shared/account storage is a later decision (GDD §5.3).

### item (item instance)
| Column       | Type        | Notes                                                    |
| ------------ | ----------- | -------------------------------------------------------- |
| id           | uuid PK     |                                                          |
| owner_character_id | uuid FK | indexed                                              |
| base_id      | text        | game-core item base (slot, base stats)                   |
| rarity_id    | text        | game-core `RarityId`                                     |
| item_level   | integer     |                                                          |
| affixes      | jsonb       | `[{ affixId, tier, value }]`, rolled server-side only    |
| upgrade_level| smallint    | default 0 (Phase 3)                                      |
| seed         | bigint      | roll seed, for audit/reproduction                        |
| source       | text        | `drop`, `offline`, `starter`, …                          |
| created_at   | timestamptz |                                                          |

### inventory_entry / equipment
An item is in exactly one place:
- `equipment (character_id, slot_id) PK → item_id UNIQUE` — `slot_id` is a game-core `EquipmentSlotId`.
- `inventory_entry (character_id, position) PK → item_id UNIQUE` — grid position; capacity enforced by the server.

Equip/unequip swaps rows inside one transaction, so an item can never be both equipped and in the bag (a `UNIQUE(item_id)` across both is enforced by a trigger or by a single `item_location` table — decide when implementing).

### activity
The character's current idle assignment, which drives offline progress.
| Column        | Type        | Notes                                                |
| ------------- | ----------- | ---------------------------------------------------- |
| character_id  | uuid PK FK  | one active activity per character                    |
| kind          | text        | `area_farm` in Phase 1                               |
| area_id       | text        | game-core area id (`abandoned-fields`)               |
| started_at    | timestamptz |                                                      |
| settled_until | timestamptz | rewards have been granted up to this instant         |

### offline_settlement
One row per settlement of elapsed time: `id`, `character_id`, `from`, `to` (capped duration), `seed`, `summary jsonb` (kills, xp, gold, item ids), `created_at`. `UNIQUE (character_id, from)` prevents settling the same window twice. Powers the "while you were away" summary.

### currency_ledger
Append-only: `id`, `character_id`, `currency` (`gold`), `delta bigint`, `balance_after bigint`, `reason` (`offline_settlement`, `combat_reward`, `vendor_sell`, …), `ref_id`, `created_at`.

### audit_log
Append-only for valuable or security-relevant events (item grants of epic+, deletions, auth events): `id`, `account_id`, `character_id?`, `event`, `data jsonb`, `created_at`.

### idempotency_key
`(account_id, key) PK`, `request_hash`, `response jsonb`, `status_code`, `created_at` (expired after 24h). See `docs/API_CONVENTIONS.md`.

## Relationships

```
account 1─* session
account 1─* character 1─1 activity
                     1─* item ─┬─ 0..1 equipment (slot)
                               └─ 0..1 inventory_entry (position)
                     1─* offline_settlement
                     1─* currency_ledger
account 1─* audit_log
account 1─* idempotency_key
```

## Open questions
- Single `item_location` table vs. separate `equipment` / `inventory_entry`.
- Offline progress cap length and whether partial settlement happens on every login or on an explicit claim.
- Whether `rng_state` lives on the character or per activity.
