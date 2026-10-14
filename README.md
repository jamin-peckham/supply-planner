# Supply Planner

A collaborative trip supply planner. Build a **library** of reusable building blocks (users, categories, supplies, standard sets and trips) and combine them into a trip, so everyone can see what's needed, who's bringing it and what's packed.

## Concepts

- **Library objects** have a GUID and a display name. They are:
  - **User:** display name and email.
  - **Category:** a grouping such as Cooking or Shelter. The built-in **Uncategorized** category can be renamed but not deleted.
  - **Supply:** a reusable item with a default category and default count.
  - **Standard set:** a ready-made bundle of categories and supplies that can be applied to any trip.
- **Trips** reference library objects by GUID, so renames show up everywhere. A trip stores only:
  - **Members:** user IDs.
  - **Category cards:** category IDs.
  - **Items:** one per supply placed on the trip, each with `count`, `status` (`needed`/`owned`), `packed` and an optional `owner`. The same supply can appear more than once, for example two stoves from two people.
- **Cascades:**
  - **Deleting a user** removes them from every trip and unassigns their items.
  - **Deleting a category** moves its supplies to Uncategorized.
  - **Deleting a supply** that a trip or set still uses archives it instead. Adding it again by name restores it.
- **Templates:** use any trip as a template for a new one ("Use as template…"), or save a trip as a standard set.

## Using it

- **Sidebar:** each section's **+** button creates an object of that type. Supplies are listed under their default category in **Categories & Supplies**, whose **+** offers a new category or a new supply (right-click a category for "New supply in this category…"). The **+** on an entry adds it to the open trip:
  - **Trip:** opens it.
  - **User:** adds them as a member.
  - **Category:** adds a card.
  - **Supply:** adds it to its default category, creating that card if needed.
  - **Standard set:** applies it to the trip.
- **Drag and drop:** drag entries onto the board, or drop a supply at a specific spot in a card. Drag items to reorder them or to move them into another card; a line shows where they'll land. Drag a card by its header to reorder the cards.
- **Right-click** any entry, card or item for more actions: edit, claim, owned/needed, remove, and template actions.
- **Cards and items** have a select checkbox and a remove button. Packed items are struck through. Click an item's **OWNED**/**NEEDED** badge to toggle it. Cards pack upward to fill gaps, masonry style.
- **Selecting items:** tick items (or click a row; shift-click selects a range; a card's checkbox selects all its items). A bar then applies **Packed**, **Unpacked**, **Owned**, **Needed**, **Assign to…** or **Remove** to every selected item. Dragging a selected item moves the whole selection. **Esc** clears it.
- **Identity:** pick yourself in **I am** (remembered per browser). There are no passwords; this is meant for a trusted network.
- **Live updates:** browsers poll every 3 seconds, so changes from other people show up automatically.

## AI access (MCP)

An [MCP](https://modelcontextprotocol.io) server is built in at `/mcp` (streamable HTTP, same port as the web UI). Agents get tools designed for a model:

- **Names or GUIDs:** every reference accepts either, and results use display names.
- **Bulk operations:** `add_items` and `update_items` change many items in one call.
- **Ordering:** `get_trip` lists cards and items in board order; `move_items` and `move_category` reorder them.
- **`trip_gaps`:** reports what's needed, unassigned or unpacked, and who is bringing what.
- **Templates:** `create_trip` can copy a template trip and apply standard sets in one call.

There is also a `trip://{id}` Markdown resource and a `plan_trip` prompt. Agent edits show up live for anyone viewing the trip.

```bash
claude mcp add --transport http supply-planner http://<host>:8085/mcp
# with a token:
claude mcp add --transport http supply-planner http://<host>:8085/mcp --header "Authorization: Bearer <token>"
```

- **`MCP_TOKEN`:** when set, `/mcp` requires `Authorization: Bearer <token>`. The web UI and REST API stay open either way.
- **What MCP can't do:** library deletes (users, categories, supplies, sets) are deliberately left out. Trip-level removals are available.

## Development

Requires [uv](https://docs.astral.sh/uv/).

```bash
uv sync
uv run uvicorn app.main:app --reload     # http://localhost:8000
uv run pytest
```

Data is stored as one YAML file per object under `./data` (override with `DATA_DIR`).

Run the server with a **single worker**. Storage relies on one in-process lock and an in-memory cache.

Bootstrap 5.3.8 and Bootstrap Icons 1.13.2 are vendored in `static/vendor`. There is no frontend build step; the frontend is plain ES modules in `static/js`.

## Docker

- **Build and run locally:**

  ```bash
  docker compose -f docker-compose.dev.yml up --build
  ```

- **Publish to Docker Hub** (linux/amd64, tagged `:<version>` and `:latest`):

  ```bash
  docker login
  scripts/docker-publish.sh
  ```

- **Production (Portainer):** create a stack from `docker-compose.yml`. It pulls `ouoertheo/supply-planner:latest`, publishes it on host port 8085 and stores data in the named volume `supply-planner-data`. Back up that volume to keep your library. To require a token for MCP, set `MCP_TOKEN` in the stack's environment.
- **Bind mount instead of a volume:** the container runs as uid `10001`, so the host directory must be writable by that uid (`chown 10001 <dir>`).
