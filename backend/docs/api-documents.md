# Documents Page API

This document lists the backend API endpoints used by the Documents page (folder explorer) in the Dataraoom platform.

## Auth
All endpoints below require a valid Bearer token.

Headers
- `Authorization: Bearer <JWT>`
- `Content-Type: application/json`

## Base URL
- Local dev: `http://localhost:<port>` (typically `5173` for frontend, backend port configured separately)

## Folder Tree (Hierarchical View)
### `GET /companies/:companyId/folders/tree`
Returns folders in a nested structure for the left tree and folder cards.

Response (example)
```json
[
  {
    "id": "...",
    "company_id": "...",
    "parent_id": null,
    "name": "Finance",
    "color": null,
    "created_by": "...",
    "created_at": "...",
    "children": [
      {
        "id": "...",
        "company_id": "...",
        "parent_id": "...",
        "name": "Q3 Reports",
        "color": null,
        "created_by": "...",
        "created_at": "...",
        "children": []
      }
    ]
  }
]
```

## Folder List (Flat)
### `GET /companies/:companyId/folders`
Returns a flat list of all folders for the company.

## Create Folder
### `POST /companies/:companyId/folders`
Creates a new folder. Use `parent_id` to create a sub-folder.

Request body
```json
{
  "name": "Legal",
  "parent_id": null,
  "color": null,
  "created_by": "<user_id>"
}
```

## Update Folder
### `PATCH /folders/:folderId`
Updates folder name or color.

Request body
```json
{
  "name": "Legal",
  "color": "#9B59B6"
}
```

## Delete Folder
### `DELETE /folders/:folderId`
Deletes a folder.

## Move Folder (Change Parent)
### `POST /folders/:folderId/move`
Moves a folder under a new parent.

Request body
```json
{
  "parent_id": "<new_parent_id>"
}
```

## Folder Documents
### `GET /folders/:folderId/documents`
Lists documents inside a folder.

### `POST /folders/:folderId/documents`
Adds a document to the folder.

Request body
```json
{
  "company_id": "<company_id>",
  "name": "Financials Q3",
  "file_url": "https://...",
  "size": "123456",
  "ext": "pdf",
  "status": "active",
  "uploaded_by": "<user_id>"
}
```

### `DELETE /documents/:documentId`
Deletes a document.

## Folder Access (Sharing)
### `GET /folders/:folderId/access`
Lists access rules for a folder.

### `POST /folders/:folderId/access`
Creates a new access rule.

Request body
```json
{
  "user_id": "<user_id>",
  "group_id": "<group_id>",
  "can_read": true,
  "can_write": false,
  "can_download": false,
  "created_by": "<user_id>"
}
```

### `PATCH /:accessId`
Updates an access rule.

Request body
```json
{
  "can_write": true
}
```

### `DELETE /:accessId`
Deletes an access rule.

## Notes
- All IDs are UUID strings.
- Default folders for a new company are created automatically in the backend:
  - Finance ? Q3 Reports
  - Legal ? Contracts
  - HR & People
  - Tax
  - M&A
  - Compliance
