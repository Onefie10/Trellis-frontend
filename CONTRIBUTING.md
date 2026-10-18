# Contributing to Trellis UI

Thank you for your interest in contributing to Trellis UI! This document provides guidelines and instructions to help you contribute effectively to this AI agent marketplace, built on the Trellis design system.

## 🚀 Tech Stack Overview

Before you begin, familiarize yourself with our core technologies:
- **Framework**: Next.js 16 (App Router)
- **Language**: TypeScript 5.3
- **UI Library**: Material UI (MUI) v9 with the custom Trellis theme
- **Styling**: TailwindCSS 3.3 + Emotion
- **State Management**: Redux Toolkit + Zustand
- **Blockchain**: Stellar SDK + Freighter wallet integration
- **Data Fetching**: React Query + Axios
- **Search**: Algolia
- **Storage**: IPFS via nft.storage
- **Testing**: Jest + React Testing Library

## 📋 Prerequisites

- Node.js 20.x or higher
- npm or yarn package manager
- Git
- A Stellar testnet account (for blockchain features)
- An Algolia account (for search features, optional)

## 🛠️ Local Development Setup

1. **Fork and clone the repository**
```bash
git clone https://github.com/your-username/trellis-ui.git
cd trellis-ui
```

2. **Install dependencies**
```bash
npm install
```

3. **Set up environment variables**
```bash
cp .env.example .env.local
```
Edit `.env.local` with your API keys and configuration values. The required variables are documented in `.env.example`.

4. **Verify environment with contributor diagnostics**
```bash
npm run diagnostics
```
The diagnostics command runs non-mutating checks against your Node.js runtime, environment variables, dependencies, network endpoints (Stellar Horizon testnet and IPFS), and test fixtures.
Useful flags:
- `npm run diagnostics -- --json` : Output machine-readable JSON format
- `npm run diagnostics -- --skip-network` : Skip external network checks (useful for offline work)
- `npm run diagnostics -- --strict` : Fail if any warnings are detected

5. **Start the development server**
```bash
npm run dev
```
The application will be available at `http://localhost:3000`

6. **Run tests**
```bash
npm run test
```

7. **Run linting**
```bash
npm run lint
```

## 📝 Code Standards

### TypeScript
- Use strict TypeScript for all new files
- Define proper interfaces for all props and state
- Avoid `any` type - use `unknown` when necessary
- Leverage TypeScript's inference where possible

### React/Next.js
- Use functional components with hooks
- Follow Next.js App Router conventions
- Implement proper loading and error states
- Optimize for performance with React.memo, useMemo, and useCallback

### Styling
- Use TailwindCSS for utility classes
- Use MUI components for complex UI elements
- Maintain the Trellis theme consistency (colors: bg-trellis-ground, text-white, etc.)
- Ensure responsive design works on all screen sizes

### Git Commit Messages
We follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:
```
type(scope): description

[optional body]

[optional footer]
```

Types:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Formatting, missing semicolons, etc.
- `refactor`: Code change that neither fixes a bug nor adds a feature
- `test`: Adding or fixing tests
- `chore`: Build process or tooling changes

## 🧪 Testing Guidelines

- Write unit tests for all new features
- Maintain test coverage above 80%
- Test edge cases and error conditions
- Use React Testing Library for component tests
- Mock external API calls and blockchain interactions
- **Local Fixtures:** Use the deterministic fixture generator (`lib/fixtures/generator.ts`) to produce stable, realistic mocked data for tests and local component development. Example usage: `new FixtureGenerator(42).generateAgent('normal')`. Scenarios such as `normal`, `edge`, and `failure` are supported for various domain types to ensure UI robustness without relying on brittle static data.
- **Domain events:** If you publish or consume a `window` or cross-tab `BroadcastChannel` message, it must go through `lib/domain-events/`. Add the event to the catalog in `lib/domain-events/registry.ts`, then add a fixture case to `tests/fixtures/domain-events/valid-events.json`. Read [docs/DOMAIN_EVENTS.md](./docs/DOMAIN_EVENTS.md) before changing a payload shape.

## 🐛 Submitting Bug Reports

When reporting bugs, please include:
1. Steps to reproduce the issue
2. Expected behavior
3. Actual behavior
4. Screenshots if applicable
5. Browser and operating system details
6. Console error messages

## ✨ Submitting Feature Requests

For new features, please:
1. Check if the feature is already in our ROADMAP.md
2. Provide a clear use case
3. Describe the proposed solution
4. Include mockups or sketches if possible
5. Discuss feasibility in a GitHub issue first

## 🔀 Pull Request Process

1. Create a feature branch from `main`
```bash
git checkout -b feature/your-feature-name
```

2. Make your changes, following our code standards

3. Ensure all tests pass
```bash
npm run test
npm run lint
npm run monitor:invariants
```

The monitor is read-only and runs in CI. If you changed a domain entity, its
status enum, or an affiliate payout rule, run it locally first — a change that
silently corrupts a fixture will fail the build. See
[docs/INVARIANT_MONITORING.md](./docs/INVARIANT_MONITORING.md).
npm run validate:events
```

`validate:events` replays the recorded event fixtures against the catalog and
fails if a registered event has no fixture. Run it whenever you touch
`lib/domain-events/` or any producer or consumer of a domain event. See
[docs/DOMAIN_EVENTS.md](./docs/DOMAIN_EVENTS.md).

4. Commit your changes using conventional commits

5. Push to your fork and submit a pull request

6. Fill out the PR template completely

7. Wait for code review and address any feedback

## 🔒 Security

- Never commit API keys or secrets to the repository
- Report security vulnerabilities privately to the maintainers
- Follow security best practices for all new code
- Keep dependencies updated

## 📖 Documentation

- Update README.md for any user-facing changes
- Document new features in the appropriate places
- Add JSDoc comments for complex functions
- Update setup instructions if requirements change
- Update [docs/DOMAIN_EVENTS.md](./docs/DOMAIN_EVENTS.md) when an event name, payload schema, version, or compatibility guarantee changes

## 💬 Community

- Join our discussions for questions and ideas
- Be respectful and inclusive (see CODE_OF_CONDUCT.md)
- Help others who are learning the codebase
- Share your use cases and feedback

Thank you for contributing to making Trellis UI a better platform! 🎉