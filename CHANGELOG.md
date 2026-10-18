# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Quadratic voting weight calculator (`Math.sqrt(staked_balance)`) and Sybil-resistance verification checks in DAO governance (`features/governance/`, `lib/governance/`) (#126)
- Side-by-side linear vs quadratic vote comparison cards and distribution graphs on proposal detail views (#126)
- Idempotency for high-risk writes: `lib/idempotency.ts` plus `apiClient.postIdempotent`, wired into payout requests and reward claims, with conflict/expiry errors and a documented server contract (`docs/idempotency.md`)
- Comprehensive open-source documentation and contributing guidelines
- GitHub issue and PR templates
- Code of Conduct and community guidelines
- Stellar blockchain integration with Freighter wallet
- IPFS storage integration via nft.storage
- Algolia search functionality for AI agents
- Redux Toolkit for state management
- Zustand for lightweight state management
- Multilingual support with i18next
- PWA support with next-pwa
- Telemetry WebSocket server
- Bundle analysis tools with source-map-explorer

### Changed
- Upgraded to Next.js 16
- Upgraded to React 18.2
- Migrated to Material UI v9
- Improved Trellis theme implementation
- Enhanced responsive design across all pages

### Fixed
- Hydration warnings in layout.tsx
- Various TypeScript strict mode errors
- Test coverage improvements
- Performance optimizations for large agent lists

## [0.1.0] - 2024-01-15

### Added
- Initial project setup with Next.js
- Trellis dark theme implementation
- Basic AI agent marketplace structure
- User authentication system
- Agent listing and detail pages
- Basic filtering and search
- Stripe payment integration
- Admin dashboard for agent management
- User profiles and reviews
- Messaging system between users and creators

### Technical Features
- TailwindCSS configuration for the Trellis design system
- Component library with reusable UI elements
- API integration layer
- Database models and schemas
- Image optimization pipeline
- Caching strategy implementation
- Error boundary components
- Loading state skeletons
- Animation system for ambient effects

## [0.0.1] - 2023-11-01

### Added
- Project initialization
- Basic directory structure
- Core configuration files
- Initial design system
- README documentation