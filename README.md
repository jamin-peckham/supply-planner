# Supply Planner

A collaborative trip supply planner. Build a **library** of reusable building blocks (users, categories, supplies, standard sets and trips) and combine them into a trip, so everyone can see what's needed, who's bringing it and what's packed.

## Concepts

- **Library objects** have a GUID and a display name. They are:
  - **User:** display name and email.
  - **Category:** a grouping such as Cooking or Shelter. The built-in **Uncategorized** category can be renamed but not deleted.
  - **Supply:** a reusable item with a default category and default count, or marked **one per person** (sleeping bag, headlamp) so trips need one for every member.
  - **Standard set:** a ready-made bundle of categories and supplies that can be applied to any trip.
- **Trips** reference library objects by GUID, so renames show up everywhere. A trip stores only:
  - **Members:** user IDs.
  - **Category cards:** category IDs.
  - **Items:** one per supply on each card. An item has a target (`count`, or one per member when `per_person` is set) and **contributions**: who brings how many, each with its own `status` (`needed` = still to get, `owned`) and `packed` flag. For example, 6 water jugs with Alice bringing 4 and Bob 2.
- **Cascades:**
  - **Deleting a user** removes them from every trip and drops their contributions.
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
- **Reorder mode (touch screens):** phones and tablets can't drag that way, so the trip header's menu has **Reorder**. It shows a grip on every item and card header; drag a grip to move it. **Done** (bottom left) or **Esc** turns the grips off again.
- **Right-click** any entry, card or item for more actions: edit, claim, owned/needed, remove, and template actions. A card's **Update library defaults** makes that category the default for the supplies on it, so the library learns from how trips are organized.
- **Cards and items** have a select checkbox and a remove button. Cards pack upward to fill gaps, masonry style.
- **Who brings what:** each item shows how much is claimed (`4/6`, amber while short) and a chip per person bringing it. A dashed amber chip means they still have to get it, a solid one that they have it, and a green one with a check that it's packed. Packing implies having it.
  - **Tap a chip** to move it along: still to get → has it → packed → back to still to get. Right-click (or long-press) a chip to jump straight to a state, change the count or remove the claim.
  - **+** claims the item for you. If several are still missing, it asks how many and defaults to all of them.
  - **One-per-person items** show an empty dashed slot for every member who hasn't claimed theirs. Tap a slot to claim it. New members get a slot automatically.
  - **Edit** (double-click or right-click) lists everyone bringing the item, with counts, status and packed, and switches between a fixed count and one per person.
  - Items are fully packed (struck through) once enough people have claimed them and every claim is packed.
- **Mine filter:** shows only what you're bringing plus your empty slots, as a personal packing list. In this view the bulk bar's Packed/Owned/Needed only touch your share.
- **Selecting items:** tick items (or click a row; shift-click selects a range; a card's checkbox selects all its items). A bar then applies **Packed**, **Unpacked**, **Owned**, **Needed**, **Assign to…** (adds that person as a contributor) or **Remove** to every selected item. Dragging a selected item moves the whole selection. **Esc** clears it.
- **Identity:** pick yourself in **I am** (remembered per browser). There are no passwords; this is meant for a trusted network.
- **Live updates:** browsers poll every 3 seconds, so changes from other people show up automatically.

## AI access (MCP)

An [MCP](https://modelcontextprotocol.io) server is built in at `/mcp` (streamable HTTP, same port as the web UI). Agents get tools designed for a model:

- **Names or GUIDs:** every reference accepts either, and results use display names.
- **Bulk operations:** `add_items` and `update_items` change many items in one call. `update_items` splits an item between people with `bringing: [{who, count, status, packed}]` (count 0 drops a claim).
- **Ordering:** `get_trip` lists cards and items in board order; `move_items` and `move_category` reorder them.
- **`update_library_defaults`:** sets supplies' default category to the card they sit on in a trip (one card or the whole trip).
- **`trip_gaps`:** reports what's short (with the members missing a per-person item), still to buy and unpacked, plus each person's packing list.
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
