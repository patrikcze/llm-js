# llm-agent: common tasks. Run `make` (or `make help`) to list them.
#
# Works with GNU Make 3.81 (macOS default) and newer. Every variable below can be overridden:
#   make start PORT=8800 WORKSPACE=~/code/project MODE=auto-edit MODEL=gpt-5.5 THINK=off

SHELL := /bin/bash
.DEFAULT_GOAL := help

# --- configuration --------------------------------------------------------------------------
NODE      ?= node
NPM       ?= npm
BIOME     ?= npx --no-install biome
TSC       ?= npx --no-install tsc
COMPOSE   ?= docker compose

PORT      ?= 8787
HOST      ?= 127.0.0.1
WORKSPACE ?= playground
MODE      ?= ask
MODEL     ?=
THINK     ?=
TASK      ?=

RUN_DIR   := .run
PID_FILE  := $(RUN_DIR)/server.pid
LOG_FILE  := $(RUN_DIR)/server.log
URL       := http://$(HOST):$(PORT)
TESTS     := test/*.test.ts

AGENT_ARGS  := -w $(WORKSPACE) --mode $(MODE) $(if $(MODEL),-m $(MODEL),) $(if $(THINK),--think $(THINK),)
SERVER_ARGS := --port $(PORT) $(AGENT_ARGS)
CLI_ARGS    := $(AGENT_ARGS)

# Small helpers (shell snippets).
# They are wrapped in { …; } so that `! $(is_running)` negates the whole check, not just its first command.
#   is_running: exit 0 when the PID file points at a live llm-agent server.
#   (Process command line from /proc on Linux, `ps -p` elsewhere; BusyBox ps has no -p.)
is_running = { [ -f $(PID_FILE) ] && pid=$$(cat $(PID_FILE)) && kill -0 $$pid 2>/dev/null && \
  { if [ -r /proc/$$pid/cmdline ]; then tr '\0' ' ' < /proc/$$pid/cmdline; else ps -p $$pid -o command=; fi; } | grep -q "src/server.ts"; }
#   healthy: exit 0 when /healthz answers.
healthy = { $(NODE) -e "fetch('$(URL)/healthz',{signal:AbortSignal.timeout(1500)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"; }
#   port_free: exit 0 when nothing listens on HOST:PORT.
port_free = { $(NODE) -e "const s=require('net').createServer().once('error',()=>process.exit(1)).once('listening',()=>s.close(()=>process.exit(0))).listen($(PORT),'$(HOST)')"; }

.PHONY: help setup install doctor \
        start stop restart status logs open dev cli run \
        check ci lint fix format format-check typecheck test test-watch coverage audit \
        docker-build docker-up docker-down docker-restart docker-logs docker-ps docker-shell search-up search-down \
        clean distclean

##@ General

help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage: make \033[36m<target>\033[0m [VAR=value]\n"} \
	  /^[a-zA-Z0-9_-]+:.*?##/ { printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2 } \
	  /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) }' $(MAKEFILE_LIST)
	@printf "\nVariables: PORT=$(PORT) HOST=$(HOST) WORKSPACE=$(WORKSPACE) MODE=$(MODE) MODEL=$(or $(MODEL),<saved/auto>) THINK=$(or $(THINK),auto)\n\n"

##@ Setup

setup: install ## First-time setup: dependencies, .env, workspace, then a health check
	@[ -f .env ] || { cp .env.example .env && echo "Created .env from .env.example"; }
	@mkdir -p $(WORKSPACE)
	@$(MAKE) --no-print-directory doctor || true

install: ## Install dependencies exactly as locked (npm ci)
	$(NPM) ci

doctor: ## Check Node, dependencies, LLM endpoint, search, port and Docker
	@PORT=$(PORT) HOST=$(HOST) $(NODE) scripts/doctor.ts

##@ Server (background, PID in .run/)

start: ## Start the web UI in the background and wait until it is healthy
	@mkdir -p $(RUN_DIR) $(WORKSPACE)
	@if $(is_running); then echo "Already running (pid $$(cat $(PID_FILE))) at $(URL)"; exit 0; fi; \
	if ! $(port_free); then echo "Port $(PORT) is already in use. Try: make start PORT=8800" >&2; exit 1; fi; \
	echo "--- $$(date '+%Y-%m-%d %H:%M:%S') start: $(SERVER_ARGS)" >> $(LOG_FILE); \
	HOST=$(HOST) nohup $(NODE) src/server.ts $(SERVER_ARGS) >> $(LOG_FILE) 2>&1 & echo $$! > $(PID_FILE); \
	for i in $$(seq 1 40); do \
	  if $(healthy); then echo "llm-agent UI running at $(URL) (pid $$(cat $(PID_FILE)), log $(LOG_FILE))"; exit 0; fi; \
	  if ! $(is_running); then break; fi; \
	  sleep 0.25; \
	done; \
	echo "Server did not become healthy. Last log lines:" >&2; tail -n 15 $(LOG_FILE) >&2; \
	$(MAKE) --no-print-directory stop >/dev/null; rm -f $(PID_FILE); exit 1

stop: ## Stop the background web UI
	@if ! $(is_running); then rm -f $(PID_FILE); echo "Not running."; exit 0; fi; \
	pid=$$(cat $(PID_FILE)); kill $$pid; \
	for i in $$(seq 1 40); do kill -0 $$pid 2>/dev/null || break; sleep 0.25; done; \
	if kill -0 $$pid 2>/dev/null; then echo "Still running after 10s; sending SIGKILL"; kill -9 $$pid; fi; \
	rm -f $(PID_FILE); echo "Stopped (pid $$pid)."

restart: ## Restart the background web UI
	@$(MAKE) --no-print-directory stop
	@$(MAKE) --no-print-directory start

status: ## Show whether the web UI runs, and with which provider/model
	@if $(is_running); then \
	  echo "Running: pid $$(cat $(PID_FILE)) at $(URL)"; \
	  $(NODE) -e "fetch('$(URL)/api/info').then(r=>r.json()).then(i=>console.log('  '+i.providerLabel+' · '+(i.model||'(no model)')+' · mode '+i.mode+' · think '+i.thinking+' · stream '+(i.stream?'on':'off')+' · search '+i.search+' · workspace '+i.workspace)).catch(e=>console.log('  /api/info failed: '+e.message))"; \
	else \
	  echo "Not running."; \
	  if ! $(port_free); then echo "  (port $(PORT) is in use by another process)"; fi; \
	fi

logs: ## Follow the background server log
	@mkdir -p $(RUN_DIR); touch $(LOG_FILE); tail -n 50 -f $(LOG_FILE)

open: ## Open the web UI in your browser
	@$(healthy) || { echo "Not running; start it with: make start" >&2; exit 1; }
	@command -v open >/dev/null && open $(URL) || xdg-open $(URL) >/dev/null 2>&1 || echo $(URL)

dev: ## Run the web UI in the foreground, restarting on file changes
	@mkdir -p $(WORKSPACE)
	HOST=$(HOST) $(NODE) --watch-path=src --watch-path=web src/server.ts $(SERVER_ARGS)

cli: ## Interactive terminal chat in WORKSPACE
	$(NODE) src/cli.ts $(CLI_ARGS)

run: ## One-shot task: make run TASK="summarise README.md"
	@[ -n "$(TASK)" ] || { echo 'Usage: make run TASK="what to do"' >&2; exit 2; }
	$(NODE) src/cli.ts $(CLI_ARGS) "$(TASK)"

##@ Quality

check: ## Everything CI checks: lint + format, types, tests
	@$(MAKE) --no-print-directory lint-ci typecheck test

ci: check audit ## check + dependency audit

lint: ## Lint (Biome)
	$(BIOME) lint

lint-ci:
	$(BIOME) ci

fix: ## Apply safe lint fixes, formatting and import sorting
	$(BIOME) check --write

format: ## Format the code
	$(BIOME) format --write

format-check: ## Fail if code is not formatted
	$(BIOME) format

typecheck: ## Type-check with tsc (no emit)
	$(TSC) -p .

test: ## Run the test suite
	$(NODE) --test $(TESTS)

test-watch: ## Re-run tests on change
	$(NODE) --test --watch $(TESTS)

coverage: ## Tests with a coverage report
	$(NODE) --test --experimental-test-coverage --test-coverage-include='src/**' $(TESTS)

audit: ## Audit production dependencies for known vulnerabilities
	$(NPM) audit --omit=dev --audit-level=high

##@ Docker (agent + SearXNG)

docker-build: ## Build the agent image
	$(COMPOSE) build agent

docker-up: ## Build and start the full stack (UI on 127.0.0.1:8787, or AGENT_PORT)
	$(COMPOSE) up -d --build

docker-down: ## Stop and remove the stack (keeps the settings volume)
	$(COMPOSE) down

docker-restart: ## Recreate the agent container
	$(COMPOSE) up -d --build --force-recreate agent

docker-logs: ## Follow the agent container log
	$(COMPOSE) logs -f agent

docker-ps: ## Show stack status
	$(COMPOSE) ps

docker-shell: ## Shell inside the agent container
	$(COMPOSE) exec agent sh

search-up: ## Start only SearXNG (for running the agent with Node)
	$(COMPOSE) up -d searxng

search-down: ## Stop SearXNG
	$(COMPOSE) stop searxng

##@ Housekeeping

clean: ## Remove logs, PID files and coverage output (stops the server first)
	@$(MAKE) --no-print-directory stop >/dev/null
	rm -rf $(RUN_DIR) coverage

distclean: clean ## clean + remove node_modules
	rm -rf node_modules
