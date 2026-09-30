"""
Adonai Thrift Store — WSGI Entrypoint for Gunicorn on Render
Executes database initialization and auto-migrations, then serves WSGI requests.
"""
import logging
from db_init import init_db
from serve import app

logger = logging.getLogger("adonai.wsgi")

# Automatically execute database verification and table auto-migrations on Render boot
try:
    logger.info("Initializing Render PostgreSQL database and verifying tables...")
    init_db()
except Exception as e:
    logger.error("Failed database initialization on WSGI startup: %s", e, exc_info=True)

# Gunicorn targets wsgi:app or wsgi:application
application = app

if __name__ == "__main__":
    import os
    port = int(os.environ.get("PORT", 10000))
    from serve import run_standalone_server
    run_standalone_server()
