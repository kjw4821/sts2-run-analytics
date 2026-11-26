CREATE TABLE VisitRooms (
    visit_room_id INTEGER PRIMARY KEY,
    floor_record_id INTEGER NOT NULL REFERENCES FloorRecords(floor_record_id) ON DELETE CASCADE,
    room_order INTEGER NOT NULL CHECK (room_order >= 1),
    room_type TEXT,
    model_id TEXT,
    UNIQUE (floor_record_id, room_order)
) STRICT;

CREATE TABLE RoomMonsters (
    visit_room_id INTEGER NOT NULL REFERENCES VisitRooms(visit_room_id) ON DELETE CASCADE,
    monster_order INTEGER NOT NULL CHECK (monster_order >= 1),
    monster_id TEXT NOT NULL,
    PRIMARY KEY (visit_room_id, monster_order)
) STRICT;
