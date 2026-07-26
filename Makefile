SHELL := /bin/bash
COMPOSE_DEV := docker compose -f docker-compose.yml
COMPOSE_TEST := docker compose -f docker-compose.test.yml
COMPOSE_INT := docker compose -f docker-compose.integration.yml

.DEFAULT_GOAL := help
.PHONY: help install build lint typecheck test-unit test-integration e2e verify \
        up down logs ps test-up test-down test-logs int-up int-down clean

help: ## Show the available targets
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | \
	  awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[1m%-22s\033[0m %s\n", $$1, $$2}'

## --- the single global verification command --------------------------------

verify: ## Run the whole verification pipeline (exits 0 only if everything passes)
	@bash scripts/verify.sh

## --- host-side checks ------------------------------------------------------

install: ## Install workspace dependencies
	pnpm install --frozen-lockfile

build: ## Build every package and application
	pnpm run db:generate && pnpm run build

lint: ## Lint the whole workspace
	pnpm run lint

typecheck: ## Type-check every package and application
	pnpm run typecheck

test-unit: ## Run the unit tests
	pnpm run test:unit

test-integration: ## Run the integration tests against throwaway Postgres and Redis
	$(COMPOSE_INT) up -d --wait
	DATABASE_URL=postgresql://app:integration_password@localhost:55432/browser_automation_integration \
	  pnpm --filter @app/database exec prisma migrate deploy
	DATABASE_URL=postgresql://app:integration_password@localhost:55432/browser_automation_integration \
	  REDIS_URL=redis://localhost:56379 \
	  JWT_SECRET=integration_test_secret_value \
	  CREDENTIALS_ENC_KEY=0123456789abcdef0123456789abcdef \
	  WORKER_URL=http://worker:5000 LOG_LEVEL=silent \
	  pnpm --filter @app/api run test:integration
	$(COMPOSE_INT) down -v

e2e: ## Run the end-to-end suite against the running test stack
	pnpm exec playwright test -c e2e/playwright.config.ts

## --- development stack -----------------------------------------------------

up: ## Start the development stack (http://localhost:8080)
	$(COMPOSE_DEV) up -d --build
	@echo "Application available on http://localhost:$${PUBLIC_PORT:-8080}"

down: ## Stop the development stack and remove its volumes
	$(COMPOSE_DEV) down -v

logs: ## Follow the development stack logs
	$(COMPOSE_DEV) logs -f

ps: ## Show the development stack status
	$(COMPOSE_DEV) ps

## --- test stack ------------------------------------------------------------

test-up: ## Start the test stack, including test-web (http://localhost:8081)
	$(COMPOSE_TEST) up -d --build
	@echo "Test stack available on http://localhost:$${TEST_PUBLIC_PORT:-8081}"

test-down: ## Stop the test stack and remove its volumes
	$(COMPOSE_TEST) down -v

test-logs: ## Follow the test stack logs
	$(COMPOSE_TEST) logs -f

int-up: ## Start only the integration data stores
	$(COMPOSE_INT) up -d --wait

int-down: ## Stop the integration data stores
	$(COMPOSE_INT) down -v

clean: ## Remove build output, logs and test artefacts
	rm -rf .verify-logs e2e/test-results e2e/playwright-report
	rm -rf packages/*/dist apps/api/dist apps/worker/dist apps/test-web/dist apps/web/.next
