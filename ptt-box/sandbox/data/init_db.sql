-- AI Assistant Database Schema
-- 在庫管理テーブル
CREATE TABLE IF NOT EXISTS inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_name TEXT NOT NULL,
    quantity INTEGER DEFAULT 0,
    location TEXT,
    notes TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 位置情報テーブル
CREATE TABLE IF NOT EXISTS locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    latitude REAL,
    longitude REAL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- メモテーブル
CREATE TABLE IF NOT EXISTS memos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- サンプルデータ
INSERT INTO inventory (item_name, quantity, location, notes) VALUES
    ('トランシーバー', 5, '倉庫A', 'Kenwood製'),
    ('バッテリー', 12, '倉庫A', '予備'),
    ('アンテナ', 3, '倉庫B', '長距離用'),
    ('イヤホンマイク', 8, '事務所', NULL);

INSERT INTO locations (name, description, latitude, longitude) VALUES
    ('本部', 'メイン拠点', 35.6812, 139.7671),
    ('倉庫A', '機材保管', 35.6801, 139.7655),
    ('倉庫B', '予備機材', 35.6798, 139.7680);
