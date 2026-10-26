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
DOCKER    ?= docker

PORT      ?= 8787
HOST      ?= 127.0.0.1
WORKSPACE ?= playground
MODE      ?= ask
MODEL     ?=
THINK     ?=
TASK      ?=

# Isolated agents (make agent-up NAME=…)
NAME        ?=
AGENT_PORT  ?=
AGENT_WS    ?= workspaces/$(NAME)
AGENT_IMAGE ?= llm-agent:latest
# Containers default to UTC; give them this machine's time zone so "local time" means yours.
TZ          ?= $(shell $(NODE) -e "console.log(Intl.DateTimeFormat().resolvedOptions().timeZone)" 2>/dev/null || echo UTC)
CONTAINER   := llm-agent-$(NAME)
# One network per agent: agents cannot reach each other, only the shared SearXNG.
NET         := llm-agent-$(NAME)-net
AGENT_TOKEN_FILE = $(RUN_DIR)/agent-$(NAME).token
# Same hardening as the compose agent: read-only root, scratch tmpfs, no capabilities, limits.
HARDENING   := --read-only --tmpfs /tmp --tmpfs /home/node:uid=1000,gid=1000,mode=0755 \
               --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 512 --memory 2g --cpus 2

RUN_DIR   := .run
PID_FILE  := $(RUN_DIR)/server.pid
TOKEN_FILE := $(RUN_DIR)/server.token
LOG_FILE  := $(RUN_DIR)/server.log
URL       := http://$(HOST):$(PORT)
TESTS     := test/*.test.ts

AGENT_ARGS  := -w $(WORKSPACE) --mode $(MODE) $(if $(MODEL),-m $(MODEL),) $(if $(THINK),--think $(THINK),)
SERVER_ARGS := --port $(PORT) $(AGENT_ARGS)
CLI_ARGS    := $(AGENT_ARGS)

# Small helpers (shell snippets).
# They are wrapped in { …; } so that `! $(is_running)` negates the whole check, not just its first command.
#   gen_token: a fresh random access token (every agent server requires one, see src/server.ts).
gen_token = $(NODE) -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
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
        agent-up agent-down agent-cleanup agent-open agents agent-logs agent-shell \
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
	@if $(is_running); then \
	  if [ -s $(TOKEN_FILE) ]; then echo "Already running (pid $$(cat $(PID_FILE))). Open: $(URL)/?token=$$(cat $(TOKEN_FILE))"; \
	  else echo "Already running (pid $$(cat $(PID_FILE))) without an access token; run: make restart"; fi; exit 0; fi; \
	if ! $(port_free); then echo "Port $(PORT) is already in use. Try: make start PORT=8800" >&2; exit 1; fi; \
	tok=$$($(gen_token)); (umask 077; echo $$tok > $(TOKEN_FILE)); \
	echo "--- $$(date '+%Y-%m-%d %H:%M:%S') start: $(SERVER_ARGS)" >> $(LOG_FILE); \
	AGENT_TOKEN=$$tok HOST=$(HOST) nohup $(NODE) src/server.ts $(SERVER_ARGS) >> $(LOG_FILE) 2>&1 & echo $$! > $(PID_FILE); \
	for i in $$(seq 1 40); do \
	  if $(healthy); then echo "llm-agent UI running (pid $$(cat $(PID_FILE)), log $(LOG_FILE))"; echo "Open: $(URL)/?token=$$tok"; exit 0; fi; \
	  if ! $(is_running); then break; fi; \
	  sleep 0.25; \
	done; \
	echo "Server did not become healthy. Last log lines:" >&2; tail -n 15 $(LOG_FILE) >&2; \
	$(MAKE) --no-print-directory stop >/dev/null; rm -f $(PID_FILE) $(TOKEN_FILE); exit 1

stop: ## Stop the background web UI
	@if ! $(is_running); then rm -f $(PID_FILE) $(TOKEN_FILE); echo "Not running."; exit 0; fi; \
	pid=$$(cat $(PID_FILE)); kill $$pid; \
	for i in $$(seq 1 40); do kill -0 $$pid 2>/dev/null || break; sleep 0.25; done; \
	if kill -0 $$pid 2>/dev/null; then echo "Still running after 10s; sending SIGKILL"; kill -9 $$pid; fi; \
	rm -f $(PID_FILE) $(TOKEN_FILE); echo "Stopped (pid $$pid)."

restart: ## Restart the background web UI
	@$(MAKE) --no-print-directory stop
	@$(MAKE) --no-print-directory start

status: ## Show whether the web UI runs, and with which provider/model
	@if $(is_running) && [ ! -s $(TOKEN_FILE) ]; then \
	  echo "Running (pid $$(cat $(PID_FILE))), but it was started before access tokens existed and has none."; \
	  echo "Run: make restart"; \
	elif $(is_running); then \
	  echo "Running: pid $$(cat $(PID_FILE)) at $(URL)"; \
	  $(NODE) -e "fetch('$(URL)/api/info',{headers:{'x-agent-token':require('fs').readFileSync('$(TOKEN_FILE)','utf8').trim()}}).then(r=>r.json()).then(i=>console.log('  '+i.providerLabel+' · '+(i.model||'(no model)')+' · mode '+i.mode+' · think '+i.thinking+' · stream '+(i.stream?'on':'off')+' · search '+i.search+' · workspace '+i.workspace)).catch(e=>console.log('  /api/info failed: '+e.message))"; \
	else \
	  echo "Not running."; \
	  if ! $(port_free); then echo "  (port $(PORT) is in use by another process)"; fi; \
	fi

logs: ## Follow the background server log
	@mkdir -p $(RUN_DIR); touch $(LOG_FILE); tail -n 50 -f $(LOG_FILE)

open: ## Open the web UI in your browser
	@$(healthy) || { echo "Not running; start it with: make start" >&2; exit 1; }
	@[ -s $(TOKEN_FILE) ] || { echo "No token file: this server was started before access tokens existed. Run: make restart" >&2; exit 1; }
	@u="$(URL)/?token=$$(cat $(TOKEN_FILE) 2>/dev/null)"; \
	command -v open >/dev/null && open "$$u" || xdg-open "$$u" >/dev/null 2>&1 || echo "$$u"

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
	@mkdir -p $(RUN_DIR); [ -s $(RUN_DIR)/docker.token ] || (umask 077; $(gen_token) > $(RUN_DIR)/docker.token)
	@AGENT_TOKEN=$$(cat $(RUN_DIR)/docker.token) TZ=$(TZ) $(COMPOSE) up -d --build
	@echo "Open: http://127.0.0.1:$${AGENT_PORT:-8787}/?token=$$(cat $(RUN_DIR)/docker.token)"

docker-down: ## Stop and remove the stack (keeps the settings volume)
	$(COMPOSE) down

docker-restart: ## Recreate the agent container
	@mkdir -p $(RUN_DIR); [ -s $(RUN_DIR)/docker.token ] || (umask 077; $(gen_token) > $(RUN_DIR)/docker.token)
	@AGENT_TOKEN=$$(cat $(RUN_DIR)/docker.token) TZ=$(TZ) $(COMPOSE) up -d --build --force-recreate agent
	@echo "Open: http://127.0.0.1:$${AGENT_PORT:-8787}/?token=$$(cat $(RUN_DIR)/docker.token)"

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

##@ Isolated agents (one container + workspace each)

agent-up: ## Start an isolated agent: make agent-up NAME=alpha [AGENT_PORT=8801] [AGENT_WS=dir]
	@[ -n "$(NAME)" ] || { echo "Usage: make agent-up NAME=<name> [AGENT_PORT=8801] [AGENT_WS=dir] [MODE=...]" >&2; exit 2; }
	@case "$(NAME)" in *[!a-zA-Z0-9_-]*) echo "NAME may only contain letters, digits, - and _" >&2; exit 2;; esac
	@if $(DOCKER) ps -a --format '{{.Names}}' | grep -qx "$(CONTAINER)"; then \
	  echo "$(CONTAINER) already exists. Stop it first: make agent-down NAME=$(NAME)" >&2; exit 1; fi
	@$(DOCKER) image inspect $(AGENT_IMAGE) >/dev/null 2>&1 || $(COMPOSE) build agent
	@# A searxng container created before the network was named needs recreating once.
	@$(COMPOSE) up -d searxng >/dev/null 2>&1 || $(COMPOSE) up -d --force-recreate searxng
	@mkdir -p "$(AGENT_WS)" $(RUN_DIR)
	@$(DOCKER) network inspect $(NET) >/dev/null 2>&1 || $(DOCKER) network create --label llm-agent.name=$(NAME) $(NET) >/dev/null
	@$(DOCKER) network connect --alias searxng $(NET) llm-agent-searxng 2>/dev/null || true
	@tok=$$($(gen_token)); (umask 077; echo $$tok > $(AGENT_TOKEN_FILE)); \
	port="$(AGENT_PORT)"; \
	[ -n "$$port" ] || port=$$($(NODE) -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"); \
	ws=$$(cd "$(AGENT_WS)" && pwd); \
	$(DOCKER) run -d --name $(CONTAINER) --label llm-agent.name=$(NAME) --restart unless-stopped \
	  --network $(NET) -p 127.0.0.1:$$port:8787 -e AGENT_TOKEN=$$tok \
	  $$([ -f .env ] && echo --env-file .env) \
	  -e LLM_BASE_URL=$${DOCKER_LLM_BASE_URL:-http://host.docker.internal:9931/v1} -e SEARXNG_URL=http://searxng:8080 -e TZ=$(TZ) \
	  --add-host host.docker.internal:host-gateway \
	  -v "$$ws":/workspace -v $(CONTAINER)-config:/config \
	  $(HARDENING) $(AGENT_IMAGE) node src/server.ts -w /workspace --mode $(MODE) $(if $(THINK),--think $(THINK),) >/dev/null || { $(MAKE) --no-print-directory agent-cleanup NAME=$(NAME); exit 1; }; \
	for i in $$(seq 1 60); do \
	  if $(NODE) -e "fetch('http://127.0.0.1:$$port/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"; then \
	    echo "Agent $(NAME) running · workspace $$ws · container $(CONTAINER) · network $(NET)"; \
	    echo "Open: http://127.0.0.1:$$port/?token=$$tok"; exit 0; fi; \
	  sleep 0.5; \
	done; \
	echo "Agent did not become healthy:" >&2; $(DOCKER) logs --tail 20 $(CONTAINER) >&2; exit 1

agent-down: ## Stop and remove an agent container (keeps its workspace and settings)
	@[ -n "$(NAME)" ] || { echo "Usage: make agent-down NAME=<name>" >&2; exit 2; }
	@if $(DOCKER) rm -f $(CONTAINER) >/dev/null 2>&1; then \
	  echo "Removed $(CONTAINER). Kept workspace $(AGENT_WS) and volume $(CONTAINER)-config."; \
	else echo "No agent named $(NAME)."; fi
	@$(MAKE) --no-print-directory agent-cleanup NAME=$(NAME)

agent-cleanup:
	@$(DOCKER) network disconnect -f $(NET) llm-agent-searxng >/dev/null 2>&1 || true
	@$(DOCKER) network rm $(NET) >/dev/null 2>&1 || true
	@rm -f $(AGENT_TOKEN_FILE)

agent-open: ## Open an agent's UI in your browser: make agent-open NAME=alpha
	@[ -n "$(NAME)" ] || { echo "Usage: make agent-open NAME=<name>" >&2; exit 2; }
	@port=$$($(DOCKER) port $(CONTAINER) 8787 2>/dev/null | head -1 | sed 's/.*://'); \
	[ -n "$$port" ] && [ -s $(AGENT_TOKEN_FILE) ] || { echo "No running agent named $(NAME) (or its token file is missing)." >&2; exit 1; }; \
	u="http://127.0.0.1:$$port/?token=$$(cat $(AGENT_TOKEN_FILE))"; \
	command -v open >/dev/null && open "$$u" || xdg-open "$$u" >/dev/null 2>&1 || echo "$$u"

agents: ## List isolated agents
	@$(DOCKER) ps -a --filter label=llm-agent.name --format 'table {{.Label "llm-agent.name"}}\t{{.Status}}\t{{.Ports}}\t{{.Names}}'

agent-logs: ## Follow an agent's log: make agent-logs NAME=alpha
	@[ -n "$(NAME)" ] || { echo "Usage: make agent-logs NAME=<name>" >&2; exit 2; }
	$(DOCKER) logs -f $(CONTAINER)

agent-shell: ## Shell inside an agent's container: make agent-shell NAME=alpha
	@[ -n "$(NAME)" ] || { echo "Usage: make agent-shell NAME=<name>" >&2; exit 2; }
	$(DOCKER) exec -it $(CONTAINER) bash

##@ Housekeeping

clean: ## Remove logs, PID files and coverage output (stops the server first)
	@$(MAKE) --no-print-directory stop >/dev/null
	rm -rf $(RUN_DIR) coverage

distclean: clean ## clean + remove node_modules
	rm -rf node_modules
