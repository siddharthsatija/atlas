# `(product)` route group

Authenticated product surfaces: `overview/`, `assets/`, `insights/`, `requests/`,
`activity/`, `archive/`, `settings/`.

- The shell (sidebar, top bar, content region) lives in this group's `layout.tsx` — ATL-005
- Route protection is enforced server-side — ATL-012
- Every route here is dynamic and user-specific: never statically rendered, never
  cached in a shared cache (architecture §15)
- Pages are Server Components; client boundaries sit at interactive leaves
