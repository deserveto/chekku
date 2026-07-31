#!/bin/bash
set -e

# Runs once on first Postgres container init (empty data volume).
# POSTGRES_DB=chekku_agent is created automatically by the image; this script
# enables pgvector in it, creates the separate chekku_auth database for Better
# Auth, and enables pgvector there too. One instance, multiple databases.

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE EXTENSION IF NOT EXISTS vector;
EOSQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE DATABASE chekku_auth;
    \c chekku_auth
    CREATE EXTENSION IF NOT EXISTS vector;
EOSQL
