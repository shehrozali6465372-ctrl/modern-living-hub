# API Documentation

## Overview

Modern Living Hub provides RESTful APIs for content management, multi-platform publishing support, and AI-powered content generation.

## Authentication

All API requests require authentication using OAuth 2.0 bearer tokens.

## Rate Limits

- Standard: 1000 requests per hour
- Premium: 10000 requests per hour

## Endpoints

### Content API
- `POST /api/v1/content/generate` — AI content generation
- `GET /api/v1/content/:id` — Retrieve content
- `PUT /api/v1/content/:id` — Update content

### Pinterest API
- `POST /api/v1/pinterest/pin` — Schedule a pin
- `GET /api/v1/pinterest/analytics` — Get pin analytics
- `GET /api/v1/pinterest/boards` — List boards

### Analytics
- `GET /api/v1/analytics/overview` — Platform analytics
- `GET /api/v1/analytics/content` — Content performance

## Error Codes

- `400` — Bad Request
- `401` — Unauthorized
- `403` — Forbidden
- `404` — Not Found
- `429` — Rate Limited
- `500` — Internal Server Error
