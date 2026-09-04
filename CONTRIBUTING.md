# Contributing to Unified Mockserver

First off — thank you for taking the time to contribute! 🎉

Unified Mockserver is an AI-augmented API virtualization & resilience-testing
platform built on top of [Microcks](https://microcks.io). Contributions of all
kinds are welcome: bug reports, feature requests, docs, and code.

By participating in this project, you agree to abide by our
[Code of Conduct](./CODE_OF_CONDUCT.md).

---

## Table of contents

- [Ways to contribute](#ways-to-contribute)
- [Project layout](#project-layout)
- [Local development setup](#local-development-setup)
- [Running the project](#running-the-project)
- [Coding guidelines](#coding-guidelines)
- [Commit messages](#commit-messages)
- [Submitting a pull request](#submitting-a-pull-request)
- [Reporting bugs](#reporting-bugs)
- [Suggesting features](#suggesting-features)
- [Security issues](#security-issues)

---

## Ways to contribute

- 🐛 **Report bugs** — open an issue using the bug report template.
- 💡 **Suggest features** — open an issue using the feature request template.
- 📝 **Improve docs** — typos, clarifications, and examples are all valuable.
- 🔧 **Submit code** — fix a bug or build a feature (see below).

If you're planning a large change, please open an issue first to discuss it so
we can align on the approach before you invest significant time.

---

## Project layout

```
.
├── server.cjs              # Express entrypoint (backend API + legacy dashboard)
├── src/                    # Modular backend
│   ├── routes/             # Express routes (ai-generate, ai-scenario, …)
│   └── lib/                # AI client, schema parsing, Microcks helpers, mocks
├── web/                    # Next.js + React + TypeScript frontend
├── artifacts/             # Seed API specs & example collections
├── scripts/                # Test generation & benchmarking utilities
├── deployment/             # Deployment assets
├── docker-compose.yml      # Full stack: frontend + backend + Microcks
└── Dockerfile              # Backend image
```

---

## Local development setup

### Prerequisites

- **Node.js** 18+ and npm
- **Docker** and **Docker Compose** (for Microcks and the full stack)

### 1. Fork & clone

```bash
git clone https://github.com/<your-username>/Mockserver.git
cd Mockserver
```

### 2. Configure environment

Copy the example environment file and fill in any values you need (an AI API
key is optional — the app falls back to deterministic generators when no key
is configured):

```bash
cp .env.example .env
```

> **Never commit your `.env`.** It is already listed in `.gitignore`.

### 3. Install dependencies

```bash
npm install            # backend deps
cd web && npm install  # frontend deps
cd ..
```

---

## Running the project

### Full stack via Docker (recommended)

```bash
docker compose up --build
# Frontend (Next.js)   → http://localhost:3000
# API / legacy UI      → http://localhost:4010
# Microcks UI          → http://localhost:8585
```

### Backend and frontend separately (for development)

```bash
# Terminal 1 — backend
npm run dev

# Terminal 2 — frontend
cd web && npm run dev
```

### Useful scripts

```bash
npm run gen:tests        # generate AI contract tests
npm run benchmark        # run benchmarks
npm run benchmark:chaos  # run resilience/chaos benchmarks
npm run docker:up        # start the stack detached
npm run docker:down      # stop the stack
```

---

## Coding guidelines

- **Match the surrounding style.** The backend uses CommonJS (`.cjs`); the
  frontend uses TypeScript + React. Keep new code consistent with its module.
- **Keep changes focused.** One logical change per PR makes review easier.
- **No secrets in code.** Configuration belongs in `.env` / `.env.example`.
- **Lint the frontend** before pushing:
  ```bash
  cd web && npm run lint
  ```
- **Prefer clarity over cleverness.** Add a short comment when the "why" isn't
  obvious from the code.

---

## Commit messages

Write clear, imperative commit messages. We recommend the
[Conventional Commits](https://www.conventionalcommits.org/) style:

```
feat: add negative-price edge case to scenario library
fix: preserve array cardinality when injecting scenarios
docs: document AI fallback behavior
chore: bump express-rate-limit to 8.5.1
```

---

## Submitting a pull request

1. Create a branch off `main`:
   ```bash
   git checkout -b feat/short-description
   ```
2. Make your changes and commit them.
3. Run the app locally and verify your change works end-to-end.
4. Push and open a pull request against `main`.
5. Fill out the PR template and link any related issues (e.g. `Closes #12`).
6. A maintainer will review; please respond to feedback and keep the branch
   up to date with `main`.

PRs should be as small and self-contained as reasonably possible.

---

## Reporting bugs

Open an issue with the **Bug report** template and include:

- What you expected to happen vs. what actually happened
- Steps to reproduce
- Environment (OS, Node version, Docker version, browser)
- Relevant logs or screenshots

---

## Suggesting features

Open an issue with the **Feature request** template. Describe the problem
you're trying to solve, not just the solution — it helps us find the best fit.

---

## Security issues

**Please do not open public issues for security vulnerabilities.** See
[SECURITY.md](./SECURITY.md) for how to report them privately.

---

Thanks again for contributing! 💚
