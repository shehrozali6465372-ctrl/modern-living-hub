# Architecture

## System Overview

Modern Living Hub is built on a modern, cloud-native architecture designed for scalability, security, and performance.

## Tech Stack

- **Frontend:** HTML5, CSS3, JavaScript (Vanilla)
- **Hosting:** GitHub Pages (CDN-backed)
- **Domain:** shehrozali6465372-ctrl.github.io/modern-living-hub
- **Security:** TLS 1.3, OAuth 2.0

## Component Architecture

```
┌─────────────────────────────────────┐
│         GitHub Pages (CDN)          │
├─────────────────────────────────────┤
│  Static Site (HTML/CSS/JS)          │
│  ├── Landing Pages                  │
│  ├── Legal Pages                    │
│  └── Documentation                  │
├─────────────────────────────────────┤
│         External Services           │
│  ├── Pinterest API                  │
│  ├── Google API                     │
│  └── Analytics Platform             │
└─────────────────────────────────────┘
```

## Security Architecture

- End-to-end encryption (TLS 1.3)
- OAuth 2.0 with PKCE
- Content Security Policy headers
- XSS and CSRF protection
- Rate limiting on all API endpoints

## Deployment

Automated via GitHub Actions on every push to main branch.
