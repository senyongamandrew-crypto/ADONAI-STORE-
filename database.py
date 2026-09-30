"""
Adonai Thrift Store — Database Engine & Connection Pooling
Handles Render Managed PostgreSQL connections, dynamic URL formatting,
connection resilience (pre-ping, recycling), and development fallbacks.
"""
import logging
import os
import re
import sys
import time
from contextlib import contextmanager

from sqlalchemy import create_engine, text
from sqlalchemy.orm import declarative_base, scoped_session, sessionmaker
from sqlalchemy.pool import QueuePool, StaticPool

# Setup structured logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger("adonai.db")

Base = declarative_base()


def mask_database_url(url: str) -> str:
    """Masks database passwords in connection URLs for safe stdout logging."""
    if not url:
        return "<empty>"
    # Matches scheme://user:password@host...
    return re.sub(r":([^/@:]+)@", ":*****@", url)


def get_formatted_database_url() -> tuple[str, bool]:
    """
    Retrieves and formats the DATABASE_URL environment variable.
    
    Render sets DATABASE_URL with 'postgres://' schema for legacy compatibility.
    SQLAlchemy 1.4+ and 2.0+ strictly require 'postgresql://'.
    
    Returns:
        (formatted_url, is_postgres_flag)
    """
    raw_url = os.environ.get("DATABASE_URL", "").strip()
    
    if raw_url:
        # Dynamic replacement of legacy postgres:// prefix
        if raw_url.startswith("postgres://"):
            formatted_url = raw_url.replace("postgres://", "postgresql://", 1)
            logger.info("Dynamically converted legacy 'postgres://' schema to 'postgresql://' for SQLAlchemy compatibility.")
        else:
            formatted_url = raw_url
        return formatted_url, True
    
    # Development fallback to SQLite
    sqlite_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "adonai.db")
    fallback_url = f"sqlite:///{sqlite_path}"
    logger.warning("DATABASE_URL not found in environment. Using local SQLite fallback: %s", fallback_url)
    return fallback_url, False


# Initialize Engine and Session Factory
DATABASE_URL, IS_POSTGRES = get_formatted_database_url()

if IS_POSTGRES:
    # High-concurrency PostgreSQL connection pool settings for Render
    POOL_SIZE = int(os.environ.get("DB_POOL_SIZE", "10"))
    MAX_OVERFLOW = int(os.environ.get("DB_MAX_OVERFLOW", "20"))
    POOL_RECYCLE = int(os.environ.get("DB_POOL_RECYCLE", "300"))  # 5 minutes to prevent Render idle timeout drops
    POOL_TIMEOUT = int(os.environ.get("DB_POOL_TIMEOUT", "30"))

    engine = create_engine(
        DATABASE_URL,
        poolclass=QueuePool,
        pool_size=POOL_SIZE,
        max_overflow=MAX_OVERFLOW,
        pool_recycle=POOL_RECYCLE,
        pool_pre_ping=True,  # Health check before checkout to auto-heal dropped connections
        pool_timeout=POOL_TIMEOUT,
        echo=False
    )
    logger.info(
        "Configured Render PostgreSQL pool: size=%d, overflow=%d, recycle=%ds, pre_ping=True",
        POOL_SIZE, MAX_OVERFLOW, POOL_RECYCLE
    )
else:
    # SQLite configuration for local testing
    engine = create_engine(
        DATABASE_URL,
        connect_args={"check_same_thread": False},
        pool_pre_ping=True,
        echo=False
    )

SessionFactory = sessionmaker(autocommit=False, autoflush=False, bind=engine)
db_session = scoped_session(SessionFactory)


@contextmanager
def get_db():
    """
    Transactional context manager for database sessions.
    Automatically commits on clean exit or rolls back on exception.
    """
    session = db_session()
    try:
        yield session
        session.commit()
    except Exception as exc:
        session.rollback()
        logger.error("Database transaction rolled back due to error: %s", exc)
        raise
    finally:
        session.close()


def verify_database_connection(max_retries: int = 3, retry_delay: float = 2.0) -> bool:
    """
    Validates live database connectivity with retry resilience on startup.
    Prints required confirmation message on successful connection.
    """
    masked_url = mask_database_url(DATABASE_URL)
    logger.info("Attempting connection to database: %s", masked_url)
    
    for attempt in range(1, max_retries + 1):
        try:
            with engine.connect() as conn:
                result = conn.execute(text("SELECT 1")).scalar()
                if result == 1:
                    if IS_POSTGRES:
                        print("Successfully connected to Render PostgreSQL Database.")
                        logger.info("Successfully connected to Render PostgreSQL Database.")
                    else:
                        print("Successfully connected to Local SQLite Database.")
                        logger.info("Successfully connected to Local SQLite Database.")
                    return True
        except Exception as err:
            logger.error(
                "[Database Error] Connection attempt %d/%d failed: %s",
                attempt, max_retries, err
            )
            if attempt < max_retries:
                time.sleep(retry_delay * attempt)
            else:
                logger.critical("[Database Error] All connection attempts to database failed.")
                return False
    return False
