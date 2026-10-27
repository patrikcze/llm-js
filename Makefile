# llm-agent: common tasks. Run `make` (or `make help`) to list them.
#
# Works with GNU Make 3.81 (macOS default) and newer. Every variable below can be overridden:
#   make start PORT=8800 WORKSPACE=~/code/project MODE=auto-edit MODEL=gpt-5.5 THINK=off

SHELL := /bin/bash
.DEFAULT_GOAL := help

# --- configuration --------------------------------------------------------------------------
NODE      ?= node
NPM       ?= npm
BIOME     ?= node_modules/.bin/biome
TSC       ?= node_modules/.bin/tsc
# Written by npm ci; targets that need Node dependencies install them first when it is missing or stale.
DEPS      := node_modules/.package-lock.json

# Container engine: Docker or Podman, whichever is installed (docker wins when both are). ENGINE is
# what actually answers: a `docker` CLI can be Podman's docker shim or talk to a Podman socket.
# Override any of these: make docker-up DOCKER=podman, ENGINE=podman, COMPOSE="podman-compose".
DOCKER    ?= $(shell command -v docker >/dev/null 2>&1 && echo docker || echo podman)
# Detected once, and only when a container target needs it.
ENGINE    ?= $(eval ENGINE := $(shell $(DOCKER) version 2>/dev/null | grep -qi podman && echo podman || echo docker))$(ENGINE)
# compose.docker.yml adds what only Docker needs (host.docker.internal on Linux); Podman has it built in.
# SearXNG gets a random secret per checkout (kept in .run/searxng.secret) instead of a fixed default.
COMPOSE   ?= SEARXNG_SECRET=$$(mkdir -p .run; [ -s .run/searxng.secret ] || (umask 077; od -An -tx1 -N24 /dev/urandom | tr -d ' \n' > .run/searxng.secret); cat .run/searxng.secret) \
             $(DOCKER) compose -f docker-compose.yml $(if $(filter docker,$(ENGINE)),-f compose.docker.yml)

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
# true keeps npm/npx in the agent image (removed by default: see Dockerfile). Compose reads it from the environment.
WITH_NPM    ?= false
export WITH_NPM
# Containers default to UTC; give them this machine's time zone so "local time" means yours.
TZ          ?= $(shell $(NODE) -e "console.log(Intl.DateTimeFormat().resolvedOptions().timeZone)" 2>/dev/null || echo UTC)
CONTAINER   := llm-agent-$(NAME)
# One network per agent: agents cannot reach each other, only the shared SearXNG.
NET         := llm-agent-$(NAME)-net
AGENT_TOKEN_FILE = $(RUN_DIR)/agent-$(NAME).token
# The image inherits Compose's labels (project llm-js, service agent); agent-up overrides them so
# Docker Desktop shows isolated agents as their own "llm-agents" group, apart from the default stack.
# Same hardening as the compose agent: read-only root, scratch tmpfs, no capabilities, limits.
# Only options both Docker and Podman accept (Podman's tmpfs has no uid=/gid=, hence mode=1777).
LIMITS      ?= --pids-limit 512 --memory 2g --cpus 2
HARDENING   := --read-only --tmpfs /tmp --tmpfs /home/node:mode=1777 \
               --cap-drop ALL --security-opt no-new-privileges $(LIMITS)

# OpenShell sandboxes (make openshell-up NAME=…): the agent image under an OpenShell policy.
OPENSHELL        ?= openshell
OPENSHELL_POLICY ?= openshell/policy.yaml
SANDBOX          := llm-agent-$(NAME)
HOST_LLM_PORT    ?= 9931
# The server's own node binary in the image, the only program the policy lets onto the network. Commands
# run through openshell/runner.py, outside the server's process tree, and cannot execute it.
OS_SERVER_NODE   := /opt/llm-agent/node
OS_FILE           = $(RUN_DIR)/openshell-$(NAME)
# Copies the contents of directory $$ws into the sandbox's /workspace (an upload of the directory
# itself would land in /workspace/<dirname>).
os_upload = for f in "$$ws"/* "$$ws"/.[!.]* "$$ws"/..?*; do [ -e "$$f" ] || continue; \
  $(OPENSHELL) sandbox upload --no-git-ignore $(SANDBOX) "$$f" /workspace >/dev/null 2>&1 || exit 1; done

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
        docker-build docker-scan docker-up docker-down docker-restart docker-logs docker-ps docker-shell search-up search-down \
        agent-up agent-down agent-cleanup agent-open agents agent-logs agent-shell docker-open searxng-attach \
        openshell-up openshell-down openshell-open openshell-allow openshell-logs openshell-pull openshell-push openshell-list \
        down purge clean distclean

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

$(DEPS): package.json package-lock.json
	@echo "Installing dependencies (npm ci)…"
	$(NPM) ci
	@touch $@

doctor: ## Check Node, dependencies, LLM endpoint, search, port and Docker
	@PORT=$(PORT) HOST=$(HOST) DOCKER=$(DOCKER) $(NODE) scripts/doctor.ts

##@ Server (background, PID in .run/)

start: $(DEPS) ## Start the web UI in the background and wait until it is healthy
	@mkdir -p $(RUN_DIR) $(WORKSPACE)
	@if $(is_running); then \
	  if [ -s $(TOKEN_FILE) ]; then echo "Already running (pid $$(cat $(PID_FILE))). Open: $(URL)/?token=$$(cat $(TOKEN_FILE))"; \
	  else echo "Already running (pid $$(cat $(PID_FILE))) without an access token; run: make restart"; fi; exit 0; fi; \
	if ! $(port_free); then echo "Port $(PORT) is already in use. Try: make start PORT=8800" >&2; exit 1; fi; \
	tok=$$($(gen_token)); (umask 077; echo $$tok > $(TOKEN_FILE)); \
	echo "--- $$(date '+%Y-%m-%d %H:%M:%S') start: $(SERVER_ARGS)" >> $(LOG_FILE); \
	AGENT_TOKEN=$$tok AGENT_OPEN_HINT="make open$(if $(filter command line,$(origin PORT)), PORT=$(PORT),)" HOST=$(HOST) nohup $(NODE) src/server.ts $(SERVER_ARGS) >> $(LOG_FILE) 2>&1 & echo $$! > $(PID_FILE); \
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

dev: $(DEPS) ## Run the web UI in the foreground, restarting on file changes
	@mkdir -p $(WORKSPACE)
	HOST=$(HOST) $(NODE) --watch-path=src --watch-path=web src/server.ts $(SERVER_ARGS)

cli: $(DEPS) ## Interactive terminal chat in WORKSPACE
	$(NODE) src/cli.ts $(CLI_ARGS)

run: $(DEPS) ## One-shot task: make run TASK="summarise README.md"
	@[ -n "$(TASK)" ] || { echo 'Usage: make run TASK="what to do"' >&2; exit 2; }
	$(NODE) src/cli.ts $(CLI_ARGS) "$(TASK)"

##@ Quality

check: ## Everything CI checks: lint + format, types, tests
	@$(MAKE) --no-print-directory lint-ci typecheck test

ci: check audit ## check + dependency audit

lint: $(DEPS) ## Lint (Biome)
	$(BIOME) lint

lint-ci: $(DEPS)
	$(BIOME) ci

fix: $(DEPS) ## Apply safe lint fixes, formatting and import sorting
	$(BIOME) check --write

format: $(DEPS) ## Format the code
	$(BIOME) format --write

format-check: $(DEPS) ## Fail if code is not formatted
	$(BIOME) format

typecheck: $(DEPS) ## Type-check with tsc (no emit)
	$(TSC) -p .

test: $(DEPS) ## Run the test suite
	$(NODE) --test $(TESTS)

test-watch: $(DEPS) ## Re-run tests on change
	$(NODE) --test --watch $(TESTS)

coverage: $(DEPS) ## Tests with a coverage report
	$(NODE) --test --experimental-test-coverage --test-coverage-include='src/**' $(TESTS)

audit: ## Audit production dependencies for known vulnerabilities
	$(NPM) audit --omit=dev --audit-level=high

##@ Docker (agent + SearXNG)

docker-build: ## Build the agent image
	$(COMPOSE) build agent

docker-scan: ## Scan the agent image for known vulnerabilities (Docker Scout or Trivy)
	@if command -v trivy >/dev/null 2>&1; then trivy image --scanners vuln --severity LOW,MEDIUM,HIGH,CRITICAL $(AGENT_IMAGE); \
	elif [ "$(ENGINE)" = docker ] && docker scout version >/dev/null 2>&1; then docker scout cves $(AGENT_IMAGE); \
	else echo "No scanner found: install Trivy (brew install trivy) or Docker Scout." >&2; exit 1; fi

docker-up: ## Build and start the default agent + SearXNG (with NAME=…: an isolated agent, same as agent-up)
ifneq ($(NAME),)
	@echo "NAME given: starting an isolated agent (make agent-up NAME=$(NAME))."
	@$(MAKE) --no-print-directory agent-up NAME=$(NAME) $(if $(AGENT_PORT),AGENT_PORT=$(AGENT_PORT),)
else
	@if [ "$(origin PORT)" = "command line" ]; then \
	  echo "docker-up uses AGENT_PORT, not PORT (PORT is for make start). Try: make docker-up AGENT_PORT=$(PORT)" >&2; exit 2; fi
	@mkdir -p $(RUN_DIR); [ -s $(RUN_DIR)/docker.token ] || (umask 077; $(gen_token) > $(RUN_DIR)/docker.token)
	@AGENT_PORT=$(or $(AGENT_PORT),8787) AGENT_TOKEN=$$(cat $(RUN_DIR)/docker.token) TZ=$(TZ) $(COMPOSE) up -d --build
	@$(MAKE) --no-print-directory searxng-attach
	@echo "Open: http://127.0.0.1:$(or $(AGENT_PORT),8787)/?token=$$(cat $(RUN_DIR)/docker.token)"
endif

docker-down: ## Stop and remove the stack (keeps the settings volume)
	$(COMPOSE) down

docker-restart: ## Recreate the agent container
	@mkdir -p $(RUN_DIR); [ -s $(RUN_DIR)/docker.token ] || (umask 077; $(gen_token) > $(RUN_DIR)/docker.token)
	@AGENT_PORT=$(or $(AGENT_PORT),8787) AGENT_TOKEN=$$(cat $(RUN_DIR)/docker.token) TZ=$(TZ) $(COMPOSE) up -d --build --force-recreate agent
	@echo "Open: http://127.0.0.1:$(or $(AGENT_PORT),8787)/?token=$$(cat $(RUN_DIR)/docker.token)"

docker-logs: ## Follow the agent container log
	$(COMPOSE) logs -f agent

docker-ps: ## Show stack status
	$(COMPOSE) ps

docker-shell: ## Shell inside the agent container
	$(COMPOSE) exec agent sh

search-up: ## Start only SearXNG (for running the agent with Node)
	$(COMPOSE) up -d searxng
	@$(MAKE) --no-print-directory searxng-attach

# A recreated SearXNG container is attached only to its own network; reconnect it to every isolated
# agent's network so running agents keep their web search.
searxng-attach:
	@for net in $$($(DOCKER) network ls --filter label=llm-agent.name --format '{{.Name}}'); do \
	  $(DOCKER) network connect --alias searxng $$net llm-agent-searxng >/dev/null 2>&1 || true; \
	done

search-down: ## Stop SearXNG
	$(COMPOSE) stop searxng

##@ OpenShell sandboxes (policy-enforced; see openshell/policy.yaml)

openshell-up: ## Start an agent in an OpenShell sandbox: make openshell-up NAME=alpha [AGENT_PORT=8801] [AGENT_WS=dir]
	@[ -n "$(NAME)" ] || { echo "Usage: make openshell-up NAME=<name> [AGENT_PORT=8801] [AGENT_WS=dir] [MODE=...]" >&2; exit 2; }
	@case "$(NAME)" in *[!a-zA-Z0-9-]*) echo "NAME may only contain letters, digits and -" >&2; exit 2;; esac
	@[ $$(printf %s "$(NAME)" | wc -c) -le 9 ] || { echo "NAME may be at most 9 characters (OpenShell limits sandbox names to 19, including llm-agent-)." >&2; exit 2; }
	@command -v $(OPENSHELL) >/dev/null || { echo "OpenShell CLI not found: https://github.com/NVIDIA/OpenShell" >&2; exit 1; }
	@$(OPENSHELL) status >/dev/null 2>&1 || { echo "No OpenShell gateway is reachable: brew services start openshell (see make doctor / openshell doctor)" >&2; exit 1; }
	@if $(OPENSHELL) sandbox get $(SANDBOX) >/dev/null 2>&1; then \
	  echo "Sandbox $(SANDBOX) already exists. Open it: make openshell-open NAME=$(NAME), or remove it: make openshell-down NAME=$(NAME)" >&2; exit 1; fi
	@$(DOCKER) image inspect $(AGENT_IMAGE) >/dev/null 2>&1 || $(COMPOSE) build agent
	@$(COMPOSE) up -d searxng >/dev/null 2>&1 || echo "SearXNG did not start; web_search will be unavailable." >&2
	@mkdir -p $(RUN_DIR) "$(AGENT_WS)"
	@tok=$$($(gen_token)); (umask 077; echo $$tok > $(OS_FILE).token); \
	port="$(AGENT_PORT)"; \
	[ -n "$$port" ] || port=$$($(NODE) -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"); \
	echo $$port > $(OS_FILE).port; \
	ws=$$(cd "$(AGENT_WS)" && pwd); \
	AGENT_TOKEN=$$tok $(OPENSHELL) sandbox create --name $(SANDBOX) --from $(AGENT_IMAGE) --policy $(OPENSHELL_POLICY) \
	  --no-auto-providers --no-tty --detach --restart-policy on-failure --no-credential-warnings \
	  --label app=llm-agent --label llm-agent.name=$(NAME) \
	  --env HOST=127.0.0.1 --env PORT=$$port --env TZ=$(TZ) --env AGENT_SANDBOX_NAME=$(NAME) \
	  --env "AGENT_OPEN_HINT=make openshell-open NAME=$(NAME)" \
	  --env LLM_BASE_URL=http://host.openshell.internal:$(HOST_LLM_PORT)/v1 --env SEARXNG_URL=http://host.openshell.internal:8888 \
	  --env-from AGENT_TOKEN \
	  -- python3 -I /app/openshell/runner.py -- $(OS_SERVER_NODE) /app/src/server.ts -w /workspace --mode $(MODE) $(if $(THINK),--think $(THINK),) >/dev/null \
	  || { echo "Could not create the sandbox (see above)." >&2; rm -f $(OS_FILE).token $(OS_FILE).port; exit 1; }; \
	( $(os_upload) ) || { echo "Could not copy $$ws into the sandbox." >&2; exit 1; }; \
	$(OPENSHELL) forward start -d 127.0.0.1:$$port $(SANDBOX) >/dev/null 2>&1 \
	  || { echo "Could not forward port $$port to the sandbox." >&2; exit 1; }; \
	for i in $$(seq 1 60); do \
	  if $(NODE) -e "fetch('http://127.0.0.1:$$port/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"; then \
	    echo "Agent $(NAME) running in OpenShell sandbox $(SANDBOX) · workspace /workspace (synced from $$ws)"; \
	    echo "Network: only your LLM (port $(HOST_LLM_PORT)) and SearXNG on this machine; every other host is denied. Commands the agent runs get no network."; \
	    echo "Allow another site: make openshell-allow NAME=$(NAME) HOST=example.com · copy work out: make openshell-pull NAME=$(NAME)"; \
	    echo "Open: http://127.0.0.1:$$port/?token=$$tok"; exit 0; fi; \
	  sleep 0.5; \
	done; \
	echo "Agent did not become healthy. Logs: make openshell-logs NAME=$(NAME)" >&2; exit 1

openshell-down: ## Copy the sandbox's workspace to AGENT_WS, then delete the sandbox: make openshell-down NAME=alpha
	@[ -n "$(NAME)" ] || { echo "Usage: make openshell-down NAME=<name>" >&2; exit 2; }
	@if ! $(OPENSHELL) sandbox get $(SANDBOX) >/dev/null 2>&1; then \
	  echo "No OpenShell sandbox named $(SANDBOX)."; rm -f $(OS_FILE).token $(OS_FILE).port; exit 0; fi; \
	$(MAKE) --no-print-directory openshell-pull NAME=$(NAME) \
	  || { echo "Could not copy the workspace out; keeping the sandbox. Force: openshell sandbox delete $(SANDBOX)" >&2; exit 1; }; \
	[ -s $(OS_FILE).port ] && $(OPENSHELL) forward stop $$(cat $(OS_FILE).port) $(SANDBOX) >/dev/null 2>&1; \
	$(OPENSHELL) sandbox delete $(SANDBOX) >/dev/null && echo "Deleted sandbox $(SANDBOX). Its workspace is in $(AGENT_WS)."; \
	rm -f $(OS_FILE).token $(OS_FILE).port

openshell-pull: ## Copy the sandbox's /workspace into AGENT_WS (default workspaces/NAME)
	@[ -n "$(NAME)" ] || { echo "Usage: make openshell-pull NAME=<name> [AGENT_WS=dir]" >&2; exit 2; }
	@mkdir -p "$(AGENT_WS)"
	@$(OPENSHELL) sandbox download $(SANDBOX) /workspace "$(AGENT_WS)" >/dev/null && echo "Copied /workspace of $(SANDBOX) to $(AGENT_WS)."

openshell-push: ## Copy AGENT_WS into the sandbox's /workspace
	@[ -n "$(NAME)" ] || { echo "Usage: make openshell-push NAME=<name> [AGENT_WS=dir]" >&2; exit 2; }
	@ws="$(AGENT_WS)"; ( $(os_upload) ) && echo "Copied $(AGENT_WS) into /workspace of $(SANDBOX)." \
	  || { echo "Could not copy $(AGENT_WS) into the sandbox." >&2; exit 1; }

openshell-open: ## Open a sandboxed agent's UI (restarts the port forward if needed)
	@[ -n "$(NAME)" ] || { echo "Usage: make openshell-open NAME=<name>" >&2; exit 2; }
	@[ -s $(OS_FILE).port ] && [ -s $(OS_FILE).token ] || { echo "No sandboxed agent named $(NAME) started from here." >&2; exit 1; }
	@port=$$(cat $(OS_FILE).port); \
	$(NODE) -e "fetch('http://127.0.0.1:$$port/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" \
	  || $(OPENSHELL) forward start -d 127.0.0.1:$$port $(SANDBOX) >/dev/null 2>&1; \
	u="http://127.0.0.1:$$port/?token=$$(cat $(OS_FILE).token)"; \
	command -v open >/dev/null && open "$$u" || xdg-open "$$u" >/dev/null 2>&1 || echo "$$u"

openshell-allow: ## Let a sandboxed agent's web_fetch reach a site: make openshell-allow NAME=alpha HOST=docs.python.org [PORT=443]
	@[ -n "$(NAME)" ] && [ -n "$(HOST)" ] && [ "$(HOST)" != "127.0.0.1" ] || { echo "Usage: make openshell-allow NAME=<name> HOST=<host> [PORT=443]" >&2; exit 2; }
	@$(OPENSHELL) policy update $(SANDBOX) --add-endpoint $(HOST):$(if $(filter command line,$(origin PORT)),$(PORT),443) --binary $(OS_SERVER_NODE) --wait >/dev/null \
	  && echo "$(SANDBOX): the agent's web_fetch (not the commands it runs) may now reach $(HOST):$(if $(filter command line,$(origin PORT)),$(PORT),443)."

openshell-logs: ## Show a sandboxed agent's logs (server and OpenShell decisions)
	@[ -n "$(NAME)" ] || { echo "Usage: make openshell-logs NAME=<name>" >&2; exit 2; }
	$(OPENSHELL) logs $(SANDBOX)

openshell-list: ## List OpenShell sandboxes
	$(OPENSHELL) sandbox list

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
	  --label com.docker.compose.project=llm-agents --label com.docker.compose.service=$(NAME) \
	  --network $(NET) -p 127.0.0.1:$$port:8787 -e AGENT_TOKEN=$$tok -e "AGENT_OPEN_HINT=make agent-open NAME=$(NAME)" \
	  $$([ -f .env ] && echo --env-file .env) \
	  -e LLM_BASE_URL=$${DOCKER_LLM_BASE_URL:-http://host.docker.internal:9931/v1} -e SEARXNG_URL=http://searxng:8080 -e TZ=$(TZ) \
	  $(if $(filter docker,$(ENGINE)),--add-host host.docker.internal:host-gateway) \
	  -v "$$ws":/workspace -v $(CONTAINER)-config:/config \
	  $(HARDENING) $(AGENT_IMAGE) node /app/src/server.ts -w /workspace --mode $(MODE) $(if $(THINK),--think $(THINK),) >/dev/null || { $(MAKE) --no-print-directory agent-cleanup NAME=$(NAME); exit 1; }; \
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
	@$(DOCKER) ps -a --filter label=llm-agent.name --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
	@echo "Open one signed in: make agent-open NAME=<name> (the default agent: make docker-open)"

docker-open: ## Open the default Docker agent's UI with its access token
	@[ -s $(RUN_DIR)/docker.token ] || { echo "No token yet: run make docker-up" >&2; exit 1; }
	@port=$$($(DOCKER) port llm-agent 8787 2>/dev/null | head -1 | sed 's/.*://'); \
	[ -n "$$port" ] || { echo "The default agent is not running: make docker-up" >&2; exit 1; }; \
	u="http://127.0.0.1:$$port/?token=$$(cat $(RUN_DIR)/docker.token)"; \
	command -v open >/dev/null && open "$$u" || xdg-open "$$u" >/dev/null 2>&1 || echo "$$u"

agent-logs: ## Follow an agent's log: make agent-logs NAME=alpha
	@[ -n "$(NAME)" ] || { echo "Usage: make agent-logs NAME=<name>" >&2; exit 2; }
	$(DOCKER) logs -f $(CONTAINER)

agent-shell: ## Shell inside an agent's container: make agent-shell NAME=alpha
	@[ -n "$(NAME)" ] || { echo "Usage: make agent-shell NAME=<name>" >&2; exit 2; }
	$(DOCKER) exec -it $(CONTAINER) bash

##@ Housekeeping

# Everything below finds what this project started by its labels and names, so it also catches
# agents and sandboxes started from another terminal or before a restart.
down: ## Stop and remove everything this project started (server, stack, agents, sandboxes); keeps workspaces, settings and images
	@echo "Stopping the local server…"; $(MAKE) --no-print-directory stop >/dev/null 2>&1 || true
	@if command -v $(OPENSHELL) >/dev/null 2>&1 && $(OPENSHELL) status >/dev/null 2>&1; then \
	  for sb in $$($(OPENSHELL) sandbox list --selector app=llm-agent 2>/dev/null | awk 'NR>1 && $$1 ~ /^llm-agent-/ {print $$1}'); do \
	    echo "OpenShell sandbox $$sb: copying its workspace out, then deleting it…"; \
	    $(MAKE) --no-print-directory openshell-down NAME=$${sb#llm-agent-} || echo "  kept $$sb (see above)" >&2; \
	  done; \
	else echo "OpenShell: no gateway reachable, skipped."; fi
	@if ! $(DOCKER) info >/dev/null 2>&1; then echo "$(DOCKER): engine not running, skipped containers."; exit 0; fi; \
	for c in $$($(DOCKER) ps -a --filter label=llm-agent.name --format '{{.Names}}' | grep '^llm-agent-' | grep -vx 'llm-agent-searxng'); do \
	  $(MAKE) --no-print-directory agent-down NAME=$${c#llm-agent-}; \
	done; \
	echo "Stopping the Compose stack (default agent + SearXNG)…"; $(COMPOSE) down --remove-orphans >/dev/null 2>&1 || true; \
	for net in $$($(DOCKER) network ls --filter label=llm-agent.name --format '{{.Name}}'); do \
	  $(DOCKER) network rm $$net >/dev/null 2>&1 && echo "Removed leftover network $$net."; \
	done; \
	echo "Done. Kept: workspaces/ and $(WORKSPACE)/, settings volumes, images and tokens in $(RUN_DIR)/ (make purge removes those, except workspaces)."

purge: ## down + delete settings volumes, the project's images and .run/ secrets (asks first; never deletes workspaces)
	@if [ "$(CONFIRM)" != "yes" ]; then \
	  if [ -t 0 ]; then \
	    printf "This stops everything and deletes saved settings and API keys (volumes), the llm-agent and SearXNG images\nand $(RUN_DIR)/ (tokens, secrets). Workspaces are kept. Type yes to continue: "; read ans; [ "$$ans" = yes ] || { echo "Cancelled."; exit 1; }; \
	  else echo "make purge deletes settings, images and secrets; run it in a terminal or with CONFIRM=yes." >&2; exit 1; fi; fi
	@$(MAKE) --no-print-directory down
	@if $(DOCKER) info >/dev/null 2>&1; then \
	  $(COMPOSE) down --volumes --rmi all >/dev/null 2>&1 || true; \
	  for v in $$($(DOCKER) volume ls --format '{{.Name}}' | grep -E '^llm-agent-.+-config$$|_agent-config$$'); do \
	    $(DOCKER) volume rm $$v >/dev/null && echo "Removed volume $$v."; \
	  done; \
	  for i in $$($(DOCKER) image ls --format '{{.Repository}}:{{.Tag}}' | grep -E '^(localhost/)?llm-agent:'); do \
	    $(DOCKER) image rm $$i >/dev/null 2>&1 && echo "Removed image $$i."; \
	  done; \
	  old=$$($(DOCKER) image ls --format '{{.Repository}}:{{.Tag}}' | grep -E '(^|/)searxng/searxng:' | tr '\n' ' '); \
	  [ -z "$$old" ] || echo "Other SearXNG images are left alone (they may not be ours): $$old"; \
	fi
	rm -rf $(RUN_DIR) coverage
	@echo "Purged. Your workspaces are untouched: workspaces/ and $(WORKSPACE)/."

clean: ## Stop the local server and remove its log, PID file and coverage output (agents' tokens stay)
	@$(MAKE) --no-print-directory stop >/dev/null
	rm -rf $(LOG_FILE) $(PID_FILE) $(TOKEN_FILE) coverage

distclean: clean ## clean + remove node_modules
	rm -rf node_modules
