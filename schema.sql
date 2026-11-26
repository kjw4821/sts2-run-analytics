PRAGMA foreign_keys = ON;

CREATE TABLE Characters (
    character_id TEXT PRIMARY KEY NOT NULL
);

CREATE TABLE Cards (
    card_id TEXT PRIMARY KEY NOT NULL
);

CREATE TABLE Relics (
    relic_id TEXT PRIMARY KEY NOT NULL
);

CREATE TABLE Runs (
    run_id INTEGER PRIMARY KEY,
    source_hash TEXT NOT NULL UNIQUE,
    character_id TEXT NOT NULL REFERENCES Characters(character_id),
    play_mode TEXT NOT NULL,
    game_mode TEXT,
    player_count INTEGER NOT NULL,
    ascension INTEGER CHECK (ascension >= 0),
    result TEXT NOT NULL CHECK (result IN ('win', 'loss', 'abandoned', 'unknown')),
    build_id TEXT,
    schema_version INTEGER CHECK (schema_version >= 0),
    CHECK ((play_mode = 'single' AND player_count = 1)
        OR (play_mode = 'multi' AND player_count >= 2))
) STRICT;

CREATE TABLE FloorRecords (
    floor_record_id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL REFERENCES Runs(run_id) ON DELETE CASCADE,
    act_number INTEGER NOT NULL CHECK (act_number >= 1),
    visit_order INTEGER NOT NULL CHECK (visit_order >= 1),
    map_point_type TEXT,
    room_type TEXT,
    current_hp INTEGER CHECK (current_hp >= 0),
    max_hp INTEGER CHECK (max_hp >= 0),
    current_gold INTEGER CHECK (current_gold >= 0),
    UNIQUE (run_id, act_number, visit_order)
) STRICT;

CREATE TABLE CardChoices (
    floor_record_id INTEGER NOT NULL REFERENCES FloorRecords(floor_record_id) ON DELETE CASCADE,
    option_order INTEGER NOT NULL CHECK (option_order >= 1),
    card_id TEXT NOT NULL REFERENCES Cards(card_id),
    room_type TEXT,
    was_picked INTEGER CHECK (was_picked IN (0, 1)),
    PRIMARY KEY (floor_record_id, option_order)
) STRICT;

CREATE TABLE RunActions (
    floor_record_id INTEGER NOT NULL REFERENCES FloorRecords(floor_record_id) ON DELETE CASCADE,
    action_type TEXT NOT NULL,
    action_order INTEGER NOT NULL CHECK (action_order >= 1),
    action_code TEXT NOT NULL,
    PRIMARY KEY (floor_record_id, action_type, action_order)
) STRICT;

CREATE TABLE RunRelics (
    run_id INTEGER NOT NULL REFERENCES Runs(run_id) ON DELETE CASCADE,
    relic_order INTEGER NOT NULL CHECK (relic_order >= 1),
    relic_id TEXT NOT NULL REFERENCES Relics(relic_id),
    added_floor INTEGER CHECK (added_floor >= 0),
    PRIMARY KEY (run_id, relic_order)
) STRICT;
