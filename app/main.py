from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError
from starlette.routing import Route

from . import config
from .mcp_server import endpoint as mcp_endpoint
from .mcp_server import mcp
from .routers import library, trips
from .services import Invalid, NotFound
from .storage import init_db


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db(config.DATA_DIR)
    mcp_endpoint.build()
    async with mcp.session_manager.run():
        yield


app = FastAPI(title="Trip Supply Planner", lifespan=lifespan)
app.include_router(library.router)
app.include_router(trips.router)
# MCP for AI agents (streamable HTTP). Optional bearer auth via MCP_TOKEN.
app.router.routes.append(Route("/mcp", endpoint=mcp_endpoint))
app.mount("/static", StaticFiles(directory=config.STATIC_DIR), name="static")


@app.exception_handler(NotFound)
async def not_found(_: Request, exc: NotFound) -> JSONResponse:
    return JSONResponse({"detail": str(exc)}, status_code=404)


@app.exception_handler(Invalid)
async def invalid(_: Request, exc: Invalid) -> JSONResponse:
    return JSONResponse({"detail": str(exc)}, status_code=400)


@app.exception_handler(ValidationError)
async def validation_error(_: Request, exc: ValidationError) -> JSONResponse:
    return JSONResponse({"detail": exc.errors(include_url=False, include_context=False)}, status_code=422)


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(config.STATIC_DIR / "index.html")
