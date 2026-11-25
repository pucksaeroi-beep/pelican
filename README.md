<div align="center">

<img src="build/icon.png" width="128" alt="Pelican icon" />

# Pelican

**A fast, modern database client for macOS — with real dumps, and a permissioned MCP server for AI.**

PostgreSQL · MySQL / MariaDB · SQLite · MongoDB · IBM Db2

![macOS](https://img.shields.io/badge/macOS-11%2B-000?logo=apple&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-39-47848F?logo=electron&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-a855f7)
![Local](https://img.shields.io/badge/data-stays%20on%20your%20Mac-success)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)

<a href="https://github.com/pucksaeroi-beep/pelican/releases/latest/download/Pelican-mac-arm64.dmg"><img src="https://img.shields.io/badge/Download%20for%20macOS-Apple%20Silicon-000?style=for-the-badge&logo=apple&logoColor=white" alt="Download Pelican for macOS" height="40" /></a>

<sub>No build needed · free · <a href="#%EF%B8%8F-download">first-launch steps</a> · <a href="https://github.com/pucksaeroi-beep/pelican/releases">all releases</a></sub>

[Download](#%EF%B8%8F-download) · [Features](#-features) · [Dumps](#-dumps) · [Transfer](#-transfer) · [AI access (MCP)](#-ai-access-mcp) · [Shortcuts](#%EF%B8%8F-keyboard-shortcuts) · [Install from source](#-install-from-source) · [ภาษาไทย](#-ภาษาไทย)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/hero-dark.png" />
  <img src="docs/screenshots/hero.png" alt="Pelican — a table with a WHERE filter, a column filter and the Query Manager" width="100%" />
</picture>

</div>

---

## ⬇️ Download

1. **[Download Pelican-mac-arm64.dmg](https://github.com/pucksaeroi-beep/pelican/releases/latest/download/Pelican-mac-arm64.dmg)** for Macs with Apple Silicon (M1 or newer). On an Intel Mac, [build it from source](#-install-from-source).
2. Open the DMG and drag **Pelican** into **Applications**.
3. The first time you open it, macOS blocks it because the app is not notarized by Apple. Go to **System Settings → Privacy & Security**, scroll down and click **Open Anyway**. You only do this once.
   Or run this in Terminal: `xattr -dr com.apple.quarantine /Applications/Pelican.app`

## Why Pelican?

DBeaver can do almost anything, but most days you use a handful of features through a dated UI, and you can't hand a database to an AI assistant without handing over everything. Pelican keeps the features you reach for every day, makes them quick, and adds the two things DBeaver doesn't have:

- 🗄 **Dumps that just work.** A whole database, some schemas, or a few tables. Dump structure, data, or both, from a right-click.
- 🔁 **Transfer into your own database.** Copy a table, a schema or a whole database from a shared server into PostgreSQL, MySQL or SQLite on your Mac, across engines.
- 🤖 **An MCP server with a permission panel.** For each connection you choose: hidden, read-only, or read & write. You can also share only some schemas or tables.
- ⚡ **Cached results by default.** Reopening a table, paging back or re-running a read shows the rows already fetched. One click or ⌘R fetches fresh rows.
- 🔌 **Connect in seconds.** Pelican finds the database servers running on your Mac. You can also paste a `postgres://…` URL. Passwords are stored as plain text, for local use.

## ✨ Features

| | |
|---|---|
| <img src="docs/screenshots/edit.png" alt="Editing rows in the grid" /> | **Edit rows in place**<br/>Double-click a cell, press ↵ or just start typing. Tab moves to the next cell. ⌫ sets NULL, ⌘⌫ deletes rows, ⌘D duplicates a row, and **+** adds one. The record panel (Space) edits the whole row, with long text and JSON on several lines.<br/><br/>Changes stay marked in the grid until you press **Save (⌘S)**. **Preview SQL** shows the statements first. They run in **one transaction**, and each must touch exactly one row, or nothing is saved. Rows are found by their primary key (MongoDB: `_id`). |
| <img src="docs/screenshots/where.png" alt="WHERE box with autocomplete" /> | **A WHERE box that completes**<br/>The SQL expression box above every table completes column names (with their types), operators like `IS NOT NULL` and `BETWEEN`, and each engine's common functions. Click into an empty box to pick a filter you used on that table before. On MongoDB it completes field names and `$` operators. |
| <img src="docs/screenshots/filter.png" alt="Column filter" /> | **Filter like a spreadsheet**<br/>Every column header has a filter. It lists the column's distinct values with counts, straight from the database. You can also set a condition (`=`, `>`, `contains`, `is NULL` …). Filters stack as chips you can remove one at a time.<br/><br/>Above the grid, the **SQL expression box** takes any `WHERE` clause, e.g. `total > 3000 AND ordered_at >= '2025-06-01'`. On MongoDB it takes a filter document instead. |
| <img src="docs/screenshots/editor.png" alt="SQL editor" /> | **SQL editor**<br/>⌘↵ runs the statement under the cursor, ⇧⌘↵ runs the whole script, ⌘. cancels. Autocomplete knows your tables and columns, and the syntax follows each engine's dialect.<br/><br/>Results use the same grid: filter, sort, the record panel (↵), and copy as TSV / CSV / JSON / Markdown / `INSERT`. Each editor tab keeps its own session, so `BEGIN … COMMIT` and `SET` work. MongoDB tabs take mongosh syntax: `db.orders.find({…}).sort({…})` or `aggregate([…])`. |
| <img src="docs/screenshots/plan.png" alt="Execution plan" /> | **Execution plans you can read**<br/>⌘E shows the estimated plan. ⇧⌘E runs `EXPLAIN ANALYZE` and adds real timings. Each step of the plan is shown with:<br/>• estimated vs. actual rows<br/>• a self-time bar<br/>• badges for **full scans** and **bad row estimates**<br/>Click a step to see all of its raw properties. Works on PostgreSQL, MySQL 8, SQLite, MongoDB (`executionStats`) and Db2. |
| <img src="docs/screenshots/dump.png" alt="Dump dialog" /> | **Dumps**: see [below](#-dumps). |
| <img src="docs/screenshots/transfer.png" alt="Transfer dialog" /> | **Transfer**: see [below](#-transfer). |
| <img src="docs/screenshots/mcp.png" alt="AI access" /> | **AI access (MCP)**: see [below](#-ai-access-mcp). |
| <img src="docs/screenshots/connect.png" alt="New connection" /> | **Connect fast**<br/>Pick an engine, click a server Pelican found on `localhost`, or paste a connection URL. Give production a colour tag so you can't mistake it. Test before you save. |

Also included:

- **Query Manager** (⌘J): every statement Pelican ran, whether from you, a table view or an AI client. It records time, duration, rows and result, and you can search it and filter it to errors. Double-click an entry to open it in an editor.
- **Navigator**: connection → database → schema → tables / views → columns, with row estimates and a filter box. PostgreSQL partitioned tables show their **partitions** (sub-partitions included) under the table.
- **Table tabs**: the Data, Columns, Indexes & keys, and DDL views of any table or collection. A partitioned table adds a **Partitions** tab (key, bounds, rows and size of each partition), and its DDL recreates the partitions too.
- **Export** the rows you loaded to CSV, JSON, Markdown or SQL `INSERT`s.
- **Editor tabs come back** after a restart.
- **Light and dark** themes follow macOS. The sidebar uses macOS vibrancy.

## 🗄 Dumps

Right-click a connection, schema or table and choose **Dump…**, or press ⇧⌘D.

| Choose | Options |
|---|---|
| **What** | Whole database · pick schemas · pick tables (with a filter and select-all) |
| **Content** | Structure + data · structure only · data only |
| **Engine** | Auto · the native tool · Pelican's built-in dumper |
| **PostgreSQL** | Data as portable `INSERT`s or fast `COPY`; plain SQL or a `pg_restore` archive; skip owners and privileges |
| **Everything** | `DROP … IF EXISTS` first, gzip, progress per table, cancel |

**Do dumps need Rust to be fast?** No. A dump is limited by the database and the disk, not by the language that copies the bytes. Pelican uses each engine's own dump tool when it is on your Mac:

- `pg_dump`: Pelican looks in Postgres.app and Homebrew, and picks a version at least as new as the server.
- `mysqldump` or `mariadb-dump`
- `mongodump`

These tools are written in C and are what DBAs trust for restores. Otherwise the built-in dumper streams rows in batches with back-pressure, so memory stays flat for any table size. It writes:

| Engine | Built-in dump output |
|---|---|
| PostgreSQL | Schemas, enums, sequences (with their current values), tables, foreign keys after the data, indexes, views and comments |
| MySQL / MariaDB | `SHOW CREATE` DDL with foreign key checks turned off during the load |
| SQLite | The original DDL in a single transaction |
| Db2 | Catalog DDL plus foreign keys |
| MongoDB | A **mongosh script** that keeps `ObjectId`, dates, `NumberLong` and `NumberDecimal`, and restores with `mongosh <uri> dump.js` |

Built-in dumps of PostgreSQL, MySQL, SQLite and MongoDB were each restored into an empty database and compared row for row; the SQLite round trip runs in `npm test`.

## 🔁 Transfer

Copy data from one connection into another, usually from a shared server into a database on your Mac. Right-click a connection, database, schema or table and choose **Transfer…**, or press ⇧⌘T.

| Choose | Options |
|---|---|
| **From** | Any connection, then tick tables, or a whole schema / database with one box |
| **To** | Any connection of the same family (SQL → SQL, MongoDB → MongoDB). Local ones are listed first. Type a schema name to copy into a new one: Pelican creates it. |
| **If it exists** | Stop · drop and recreate · empty it first · add rows |
| **Copy** | Tables (structure) · rows · indexes |

- **Between different engines** the column types are mapped, e.g. PostgreSQL `jsonb` → MySQL `json`, `bytea` → `longblob`, `timestamptz` → `datetime` in UTC, MySQL `tinyint(1)` → `boolean`. Between the same engine, types and defaults are copied as written.
- **Keys and ids**: primary keys come along, `serial` / identity / `AUTO_INCREMENT` columns stay auto-numbered, and their counters continue after the highest copied id.
- **Big tables** stream in batches. Each batch is a multi-row `INSERT` in its own transaction, so memory stays flat. Progress shows per table, and you can cancel.
- The source is only read. Foreign keys, triggers and views are not copied.

Every pair of engines was tried with mock data (PostgreSQL ⇄ MySQL ⇄ SQLite ⇄ Db2, MongoDB → MongoDB), including `bytea`, `jsonb`, `uuid`, arrays, enums, time zones and Thai text.

## 🤖 AI access (MCP)

Pelican runs an [MCP](https://modelcontextprotocol.io) server on `127.0.0.1`, so Claude Code and other AI clients can explore and query your databases. They only get **what you allow**:

| Per connection | |
|---|---|
| **Off** (default) | Hidden from AI clients. |
| **Read only** | PostgreSQL and MySQL run every query inside a `READ ONLY` transaction, and SQLite uses a read-only handle, so the database itself refuses writes. A statement check also runs first. MongoDB allows only find, aggregate (without `$out` / `$merge`), count and distinct. |
| **Read & write** | Adds an `execute` tool (and `mongo_write`). With **Ask me before every change** on, Pelican shows the statement in a dialog and waits for Allow / Deny. |
| **Scope** | Everything, or only the schemas and tables you tick. Pelican asks **the database's own planner** which tables a statement reads (`EXPLAIN` on PostgreSQL / MySQL / Db2, the bytecode on SQLite). That includes tables behind views and subqueries. A PostgreSQL partition counts as its partitioned table, so sharing the table shares its partitions, and `describe_table` tells the AI the partition key and bounds. |
| **Rows per query** | A cap on how many rows the AI client gets back. |

Connect Claude Code with one command. The MCP window has a **Copy** button that fills in your token:

```bash
claude mcp add --transport http pelican http://127.0.0.1:7429/mcp --header "Authorization: Bearer <token>"
```

Other clients take JSON config with `type: "http"`, the URL and the same header. The tools are:

- `list_connections`, `list_tables`, `describe_table`
- `query`, `explain` and `execute`
- `mongo_find`, `mongo_aggregate` and `mongo_write`

Every call shows up in the window's activity list. Queries, changes and refusals also go to the Query Manager, tagged **AI**.

> [!NOTE]
> The server only listens on `127.0.0.1` and requires the token. It also rejects requests from web pages, by checking the Origin and Host headers. On Db2, read-only access relies on the statement check, so for a hard guarantee give Pelican a Db2 user with read-only grants.

## ⌨️ Keyboard shortcuts

| Keys | Action |
|---|---|
| ⌘N | New connection |
| ⌘T | New SQL editor |
| ⌘↵ / ⇧⌘↵ | Run statement / run script |
| ⌘E / ⇧⌘E | Explain / explain analyze |
| ⌘. | Cancel the running query |
| ⌘R | Refresh, skipping the cache |
| ⇧⌘D | Dump… |
| ⇧⌘T | Transfer… |
| ⇧⌘M | AI access (MCP) |
| ⌘J | Query Manager |
| ⌘B | Sidebar |
| ⌘1…9 · ⌃⇥ | Switch tabs |
| ⌘W | Close tab |
| ↵ · double-click · typing | Edit the cell (in a table tab) |
| ⌫ · ⌘⌫ · ⌘D | Set NULL · delete rows · duplicate a row |
| ⌘S | Save changes |
| Space | Record panel for the selected row (↵ in query results) |
| ⌘C in a grid | Copy the selection (right-click for CSV / JSON / INSERT / Markdown) |

## 📦 Install from source

Requires **Node.js 22+** (`brew install node`).

```bash
git clone https://github.com/pucksaeroi-beep/pelican.git
cd pelican
npm install
npm run install-app        # builds Pelican.app and copies it to /Applications
```

| Command | What it does |
|---|---|
| `npm run dev` | Development mode with hot reload |
| `npm start` | Build, then run from the repo |
| `npm run dist` | Build `release/mac-arm64/Pelican.app` |
| `npm run install-app` | `dist`, then copy to `/Applications` |
| `npm run release` | `dist`, then publish the DMG as a GitHub release |
| `npm test` | Statement splitting, SQL building, edits, type mapping, MCP permissions, dump round trips |

**Try it with sample data.** `scripts/seed-demo.cjs` creates a made-up `shop` database: customers, products, orders and order items. All of it is mock data.

```bash
node scripts/seed-demo.cjs sqlite ~/Desktop/shop.db
node scripts/seed-demo.cjs postgres postgres://postgres@localhost:5432/postgres   # creates schema "shop"
node scripts/seed-demo.cjs mysql mysql://root:secret@localhost:3306/              # creates database "shop"
node scripts/seed-demo.cjs mongo mongodb://localhost:27017/                       # creates database "shop"
```

## 💾 Where data lives

Everything is in `~/Library/Application Support/Pelican/`:

| File | Contents |
|---|---|
| `connections.json` | Your connections, passwords included (plain text, mode 600) |
| `config.json` | Settings, MCP settings, per-connection AI access, window layout |
| `history.jsonl` | The Query Manager log (last 5,000 entries) |
| `scripts/` | Open SQL editor tabs |

Cached results live only in memory and are gone when you quit.

## 🧱 Project structure

```
electron/
  main.cjs            window, menus, IPC, result cache wiring
  store.cjs           config, connections, history, editor tabs, result cache
  dump.cjs            native tools + built-in streaming dumper
  transfer.cjs        copy tables between connections, with type mapping
  mcp.cjs             MCP server (Streamable HTTP) and permission checks
  drivers/            pg · mysql · sqlite (worker thread) · mongo · db2, one interface
  lib/sqltext.cjs     statement splitting, read-only checks, quoting
src/
  views/              sidebar, table tab, SQL editor, Query Manager
  dialogs/            connection, dump, transfer, AI access, settings
  ui/                 virtual grid with filters and editing, plan viewer, CodeMirror setup
scripts/              dev, packaging, release, demo data
test/                 node --test suites
```

## 📄 License

[MIT](LICENSE). Pelican is not affiliated with DBeaver, PostgreSQL, MySQL, SQLite, MongoDB or IBM. Engine names are shown as plain-text badges.

---

## 🇹🇭 ภาษาไทย

**ดาวน์โหลดไปใช้ได้เลย ไม่ต้อง build เอง:** [Pelican-mac-arm64.dmg](https://github.com/pucksaeroi-beep/pelican/releases/latest/download/Pelican-mac-arm64.dmg) (สำหรับ Mac ชิป M1 ขึ้นไป) เปิดไฟล์แล้วลาก Pelican ไปไว้ใน Applications ตอนเปิดครั้งแรก macOS จะไม่ยอมให้เปิด ให้ไปที่ **System Settings → Privacy & Security** แล้วกด **Open Anyway** (ทำแค่ครั้งเดียว)

**Pelican** เป็นโปรแกรมจัดการฐานข้อมูลสำหรับ Mac ใช้แทน DBeaver ได้ หน้าตาทันสมัยกว่าและเร็วกว่า รองรับ PostgreSQL, MySQL/MariaDB, SQLite, MongoDB และ IBM Db2

**ทำอะไรได้บ้าง**

- **Dump:**
  - เลือกได้ว่าจะ dump ทั้ง database, เฉพาะบาง schema หรือเฉพาะบางตาราง
  - เลือกได้ว่าเอาโครงสร้าง ข้อมูล หรือทั้งสองอย่าง
  - ใช้ `pg_dump` / `mysqldump` / `mongodump` เมื่อมีในเครื่อง ถ้าไม่มีจะใช้ตัว dump ในแอป ซึ่งอ่านข้อมูลทีละชุด ตารางใหญ่แค่ไหนก็ไม่กินหน่วยความจำเพิ่ม
  - ไม่จำเป็นต้องเขียนด้วย Rust เพราะความเร็วขึ้นกับฐานข้อมูลและดิสก์ ไม่ได้ขึ้นกับภาษา
- **แก้ข้อมูลในตารางได้เลย (inline edit):**
  - ดับเบิลคลิกที่ช่อง กด ↵ หรือพิมพ์ทับได้ทันที กด Tab เพื่อไปช่องถัดไป
  - ⌫ ตั้งค่าเป็น NULL, ⌘⌫ ลบแถว, ⌘D คัดลอกแถว, ปุ่ม **+** เพิ่มแถว และแก้ทั้งแถวได้ใน record panel (Space)
  - ช่องที่แก้จะมีสีกำกับไว้จนกว่าจะกด **Save (⌘S)** กด **Preview SQL** เพื่อดูคำสั่งก่อนได้ ทุกคำสั่งรันใน transaction เดียว ถ้ามีคำสั่งไหนไม่ตรงกับหนึ่งแถวพอดี จะไม่บันทึกอะไรเลย
- **Transfer (⇧⌘T):**
  - คัดลอกตาราง ทั้ง schema หรือทั้ง database จาก server อื่นมาลง database ในเครื่องเรา
  - ข้าม engine ได้ เช่น PostgreSQL → SQLite, MySQL → PostgreSQL, Db2 → MySQL โดยแปลงชนิดคอลัมน์ให้เอง
  - เลือกได้ว่าถ้ามีตารางชื่อเดียวกันอยู่แล้วจะ หยุด, ลบแล้วสร้างใหม่, ล้างข้อมูลก่อน หรือเพิ่มแถวต่อท้าย
  - คัดลอก primary key, index และ id ที่รันอัตโนมัติมาด้วย ตารางใหญ่แค่ไหนก็ไม่กินหน่วยความจำ
- **ตัวกรอง:**
  - ช่อง SQL expression (WHERE) อยู่เหนือตาราง พิมพ์แล้วมี autocomplete ชื่อคอลัมน์ (พร้อมชนิดข้อมูล), operator และฟังก์ชันที่ใช้บ่อย คลิกช่องว่างเพื่อเลือกตัวกรองที่เคยใช้กับตารางนั้น
  - ตัวกรองรายคอลัมน์แสดงค่าที่มีในคอลัมน์พร้อมจำนวน ติ๊กเลือกได้เหมือน Excel
  - ตั้งเงื่อนไขอย่าง `>`, `contains`, `is NULL` ได้ด้วย
- **Query Manager (⌘J):** ประวัติทุก query ที่รัน ค้นหาได้ และกรองเฉพาะที่ error ได้
- **Execution plan (⌘E / ⇧⌘E):** แสดงเป็นแผนผังพร้อมแถบเวลา จำนวนแถวที่คาดไว้เทียบกับที่ได้จริง และเตือนเมื่อเจอ full scan
- **SQL editor:** เติมชื่อตารางและคอลัมน์ให้อัตโนมัติ รันทีละคำสั่ง (⌘↵) หรือทั้งสคริปต์ (⇧⌘↵) ได้
- **Partition (PostgreSQL):** ตารางที่แบ่ง partition จะแสดง partition ทั้งหมด (รวม sub-partition) ไว้ใต้ตารางในแถบซ้าย และมีแท็บ Partitions บอก key, ช่วงค่า, จำนวนแถว และขนาดของแต่ละ partition DDL ที่สร้างก็มีคำสั่งสร้าง partition ครบ
- **Cache เปิดไว้เป็นค่าเริ่มต้น:** เปิดตารางเดิมหรือรัน query เดิมซ้ำจะไม่ไปดึงจากฐานข้อมูลใหม่ กด ⌘R หรือปุ่ม ↻ เมื่อต้องการข้อมูลล่าสุด ถ้าปิด cache แอปจะดึงใหม่ทุกครั้ง
- **AI (MCP):**
  - ให้ Claude Code หรือ AI ตัวอื่นใช้ฐานข้อมูลได้ โดยกำหนดสิทธิ์แยกแต่ละ connection เป็นปิด, อ่านอย่างเดียว หรืออ่านและเขียน
  - จำกัดให้เห็นเฉพาะบาง schema หรือบางตารางได้ ถ้าแชร์ตารางที่แบ่ง partition (PostgreSQL) ก็จะรวมทุก partition ของตารางนั้นด้วย และ AI จะรู้ partition key กับช่วงค่าของแต่ละ partition
  - ตั้งให้ถามก่อนทุกครั้งที่ AI จะแก้ข้อมูลได้
- **เชื่อมต่อง่าย:** แอปหา database ที่รันอยู่ในเครื่องให้เอง หรือวาง URL อย่าง `postgres://…` ได้เลย รหัสผ่านเก็บเป็นข้อความธรรมดาเพราะใช้ในเครื่อง

**ติดตั้งจากซอร์สโค้ด**

```bash
git clone https://github.com/pucksaeroi-beep/pelican.git && cd pelican
npm install && npm run install-app
```

**เชื่อมกับ Claude Code:** เปิด **AI access (MCP)** (⇧⌘M) แล้วเปิดสวิตช์ เลือกสิทธิ์ให้แต่ละ connection จากนั้นกด **Copy** แล้ววางคำสั่งใน Terminal
