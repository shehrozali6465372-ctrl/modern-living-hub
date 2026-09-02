# Modern Living Hub

**Universal AI Content Operating System**

Modern Living Hub is a cutting-edge Universal AI Content Operating System that combines artificial intelligence with multi-platform publishing support. Create, manage, and distribute content at scale with intelligent automation.

## Features

- **Universal AI Content OS** — End-to-end content management powered by artificial intelligence
- **Pinterest API Integration** — Real Pinterest OAuth 2.0 authentication, board management, and pin publishing via Pinterest API v5
- **AI Publishing Platform** — Intelligent content generation, optimization, and multi-channel distribution
- **Responsive Design** — Mobile-friendly, accessible, and SEO-optimized

## Architecture

```
modern-living-hub/
├── server/                     ← Node.js + Express backend (Pinterest OAuth + API)
│   ├── src/
│   │   └── server.js           ← Main Express server
│   ├── .env.example            ← Template for environment variables
│   ├── package.json
│   └── README.md               ← Backend setup and API documentation
├── assets/
│   ├── css/
│   │   └── style.css           ← Includes Pinterest integration styles
│   ├── js/
│   │   ├── main.js             ← Core site JavaScript
│   │   └── pinterest.js        ← Pinterest OAuth + API frontend JS
│   └── images/
├── docs/
│   ├── company.md
│   ├── api.md
│   └── architecture.md
├── .github/
│   └── workflows/
│       └── pages.yml
├── index.html                  ← Homepage with Connect Pinterest button
├── pinterest.html              ← Pinterest boards + pin creation page
├── about.html
├── contact.html
├── privacy-policy.html
├── terms-of-service.html
├── security.html
├── cookies.html
├── disclaimer.html
├── affiliate-disclosure.html
├── 404.html
├── robots.txt
├── sitemap.xml
├── favicon.ico
├── README.md
├── LICENSE
└── .gitignore
```

## Quick Start

### Frontend (GitHub Pages)

The site is static HTML served by GitHub Pages. No build step required.

- **Production URL:** [https://shehrozali6465372-ctrl.github.io/modern-living-hub](https://shehrozali6465372-ctrl.github.io/modern-living-hub)

### Backend (Pinterest OAuth + API)

The backend must be deployed separately and handles Pinterest OAuth and API calls.

```bash
cd server
npm install
cp .env.example .env
# Edit .env with your Pinterest app credentials
npm start
```

See `server/README.md` for full API documentation and deployment options.

## Pinterest Integration Setup

1. Create a Pinterest Developer App at https://developers.pinterest.com/apps/
2. Enable Pinterest API v5
3. Configure OAuth with the redirect URI matching `PINTEREST_REDIRECT_URI` from `.env`
   (format: `https://YOUR-BACKEND-DOMAIN.com/auth/pinterest/callback`)
4. Request Standard Access with scopes: `boards:read`, `boards:write`, `pins:read`, `pins:write`
5. Deploy the backend (see `server/README.md` for options)
6. Set the following environment variables on the backend:
   - `PINTEREST_CLIENT_ID`
   - `PINTEREST_CLIENT_SECRET`
   - `PINTEREST_REDIRECT_URI` (must match Pinterest app registration exactly)
   - `SESSION_SECRET`
   - `FRONTEND_URL` (e.g. `https://shehrozali6465372-ctrl.github.io/modern-living-hub`)
7. Set `window.BACKEND_URL` in `index.html` and `pinterest.html` to the deployed backend domain.
   The frontend shows a clear configuration error if this is not set.

## Backend Environment Variables

| Variable                  | Required | Purpose                                            |
|---------------------------|----------|----------------------------------------------------|
| `PINTEREST_CLIENT_ID`     | Yes      | Pinterest developer app client ID                  |
| `PINTEREST_CLIENT_SECRET` | Yes      | Pinterest app secret (server-side only)            |
| `PINTEREST_REDIRECT_URI`  | Yes      | Exact callback URL registered in Pinterest app     |
| `SESSION_SECRET`          | Yes      | Random string for session encryption               |
| `FRONTEND_URL`            | Yes      | Full frontend base URL with project path. CORS is derived from origin.|
| `NODE_ENV`                | No       | Set `production` for secure HTTPS cookies          |

## Cross-Origin Deployment Notes

- **Frontend:** GitHub Pages (`https://shehrozali6465372-ctrl.github.io`)
- **Backend:** Separate Node.js server on its own HTTPS domain
- Backend CORS allows only the origin derived from `FRONTEND_URL` (no wildcards).
- Production sessions use `SameSite=None` + `Secure=true` so cross-origin
  requests from the GitHub Pages frontend can be authenticated.

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

## Contact

- **Email:** shehrozali6465371@gmail.com
- **GitHub:** [github.com/shehrozali6465372-ctrl](https://github.com/shehrozali6465372-ctrl)
- **Website:** [shehrozali6465372-ctrl.github.io/modern-living-hub](https://shehrozali6465372-ctrl.github.io/modern-living-hub)
