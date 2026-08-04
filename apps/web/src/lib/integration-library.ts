/**
 * The integration library: a curated catalog of business systems an operator
 * can connect without hunting down MCP details themselves. Each entry prefills
 * the same connect-a-server drawer used for custom servers — one code path
 * saves everything, and every connection is probed before it is kept.
 *
 * Three kinds of availability:
 *  - 'hosted'    — the vendor runs a remote MCP server at a stable URL.
 *  - 'self_host' — the vendor ships an official server you run yourself.
 *  - 'gateway'   — no official server; connect through an MCP gateway
 *                  (Zapier, Composio, Pipedream) that exposes the app.
 *
 * `auth` picks the drawer's default sign-in method. Servers that mandate an
 * interactive OAuth flow carry 'oauth'; ones that accept a standing token
 * carry 'headers'. Either can be overridden in the drawer.
 *
 * URLs here were verified against vendor docs in July 2026. A stale URL is
 * harmless — the connection test catches it — but keep this list honest.
 */

export type LibraryAvailability = 'hosted' | 'self_host' | 'gateway'

export type IntegrationLibraryEntry = {
  /** Prefills the connection slug; tool names are namespaced under it. */
  slug: string
  label: string
  /** One operator-facing sentence: what agents can do once connected. */
  description: string
  group: string
  availability: LibraryAvailability
  /**
   * How this server expects to be authenticated; defaults to pasted headers.
   * 'm2m' is the client-credentials flow: the company registers a certificate
   * once and the connection authenticates as itself, with no operator sign-in
   * and no refresh token to lapse. Prefer it wherever a vendor offers it for a
   * system agents work in daily.
   */
  auth?: 'headers' | 'oauth' | 'm2m'
  /** Prefilled server URL, when the vendor hosts one at a stable address. */
  url?: string
  /** Guidance when the URL is per-account or the server runs elsewhere. */
  urlHint?: string
  /** Where the credential comes from and what header to paste. */
  authHint?: string
  /** Action category the autonomy dial governs this connection under. */
  defaultCategory: string
}

export const LIBRARY_GROUPS = [
  'Accounting & ERP',
  'Payments & banking',
  'Files & documents',
  'CRM & sales',
  'Customer support',
  'Project management',
  'Field service',
  'HR & payroll',
  'Commerce & marketing',
  'Gateways',
] as const

const GATEWAY_HINT =
  'No official MCP server — create a connection for this app in an MCP gateway (Zapier, Composio, or Pipedream, under Gateways below) and paste the server URL it gives you.'

export const INTEGRATION_LIBRARY: IntegrationLibraryEntry[] = [
  // --- Accounting & ERP ------------------------------------------------------
  {
    slug: 'quickbooks',
    label: 'QuickBooks Online',
    description: 'Invoices, bills, customers, and the general ledger in QuickBooks Online.',
    group: 'Accounting & ERP',
    availability: 'self_host',
    urlHint:
      'Intuit ships an official MCP server, in early preview (github.com/intuit/quickbooks-online-mcp-server). Run it behind an HTTP endpoint and paste that URL — or connect through a gateway instead.',
    defaultCategory: 'money_adjacent',
  },
  {
    slug: 'xero',
    label: 'Xero',
    description: 'Invoices, contacts, bank transactions, and reports in Xero.',
    group: 'Accounting & ERP',
    availability: 'hosted',
    auth: 'oauth',
    url: 'https://mcp.xero.com/mcp',
    defaultCategory: 'money_adjacent',
  },
  {
    slug: 'netsuite',
    label: 'NetSuite',
    description: 'Records, transactions, and saved searches in Oracle NetSuite.',
    group: 'Accounting & ERP',
    availability: 'hosted',
    auth: 'm2m',
    urlHint:
      'NetSuite’s endpoint is per-account, from the AI Connector Service. Install the MCP Standard Tools SuiteApp, enable OAuth 2.0, then paste your account’s URL.',
    authHint:
      'NetSuite needs the application made first — it will not register one on its own. Under Setup → Integration → Manage Integrations, create an integration with the Client Credentials (Machine to Machine) Grant ticked, and copy the Client ID shown on save — NetSuite displays it once. Generate an RSA-PSS key pair (openssl req -x509 -newkey rsa-pss -keyout private.pem -out public.pem -nodes -sha256), then under Setup → Integration → Manage Authentication → OAuth 2.0 Client Credentials (M2M) Setup, map that application to an entity and role and upload public.pem. NetSuite hands back a Certificate ID for the field above. Choose the role carefully: it decides exactly what your agents can reach, and Administrator is the wrong answer. Paste private.pem below — it is sealed at rest and never leaves the server.',
    defaultCategory: 'money_adjacent',
  },
  {
    slug: 'sage_intacct',
    label: 'Sage Intacct',
    description: 'GL entries, AP/AR, and dimensions in Sage Intacct.',
    group: 'Accounting & ERP',
    availability: 'gateway',
    urlHint: GATEWAY_HINT,
    defaultCategory: 'money_adjacent',
  },
  {
    slug: 'freshbooks',
    label: 'FreshBooks',
    description: 'Invoices, expenses, and time tracking in FreshBooks.',
    group: 'Accounting & ERP',
    availability: 'gateway',
    urlHint: GATEWAY_HINT,
    defaultCategory: 'money_adjacent',
  },
  {
    slug: 'zoho_books',
    label: 'Zoho Books',
    description: 'Invoices, bills, and banking in Zoho Books.',
    group: 'Accounting & ERP',
    availability: 'gateway',
    urlHint: GATEWAY_HINT,
    defaultCategory: 'money_adjacent',
  },
  {
    slug: 'bill_com',
    label: 'BILL',
    description: 'AP/AR bills, payments, and approvals in BILL (Bill.com).',
    group: 'Accounting & ERP',
    availability: 'gateway',
    urlHint: GATEWAY_HINT,
    defaultCategory: 'money_adjacent',
  },
  {
    slug: 'expensify',
    label: 'Expensify',
    description: 'Expense reports and receipts in Expensify.',
    group: 'Accounting & ERP',
    availability: 'gateway',
    urlHint: GATEWAY_HINT,
    defaultCategory: 'money_adjacent',
  },

  // --- Payments & banking ----------------------------------------------------
  {
    slug: 'stripe',
    label: 'Stripe',
    description: 'Customers, invoices, payments, refunds, and disputes in Stripe.',
    group: 'Payments & banking',
    availability: 'hosted',
    url: 'https://mcp.stripe.com',
    authHint: 'Paste "Authorization: Bearer rk_…" using a restricted API key from the Stripe dashboard.',
    defaultCategory: 'money_adjacent',
  },
  {
    slug: 'square',
    label: 'Square',
    description: 'Payments, orders, catalog, and customers in Square.',
    group: 'Payments & banking',
    availability: 'hosted',
    auth: 'oauth',
    url: 'https://mcp.squareup.com/sse',
    defaultCategory: 'money_adjacent',
  },
  {
    slug: 'paypal',
    label: 'PayPal',
    description: 'Invoices, orders, and transaction lookups in PayPal.',
    group: 'Payments & banking',
    availability: 'hosted',
    auth: 'oauth',
    url: 'https://mcp.paypal.com/http',
    defaultCategory: 'money_adjacent',
  },
  {
    slug: 'plaid',
    label: 'Plaid',
    description: 'Bank account data, balances, and transactions through Plaid.',
    group: 'Payments & banking',
    availability: 'hosted',
    auth: 'oauth',
    url: 'https://api.dashboard.plaid.com/mcp/',
    defaultCategory: 'money_adjacent',
  },
  {
    slug: 'ramp',
    label: 'Ramp',
    description: 'Card transactions, reimbursements, and spend programs in Ramp.',
    group: 'Payments & banking',
    availability: 'hosted',
    auth: 'oauth',
    url: 'https://mcp.ramp.com/mcp',
    urlHint: 'Ramp allowlists redirect URIs — ask their support to approve yours before signing in.',
    defaultCategory: 'money_adjacent',
  },
  {
    slug: 'brex',
    label: 'Brex',
    description: 'Card transactions, budgets, and expenses in Brex.',
    group: 'Payments & banking',
    availability: 'gateway',
    urlHint: GATEWAY_HINT,
    defaultCategory: 'money_adjacent',
  },

  // --- Files & documents -------------------------------------------------------
  {
    slug: 'microsoft365',
    label: 'Microsoft 365',
    description: 'OneDrive files, SharePoint sites, and Outlook data over Microsoft Graph.',
    group: 'Files & documents',
    availability: 'gateway',
    urlHint:
      'Microsoft’s own M365 MCP servers are gated to Copilot-licensed organizations. Until yours has one, connect through a gateway.',
    defaultCategory: 'file_write',
  },
  {
    slug: 'google_workspace',
    label: 'Google Workspace',
    description: 'Drive files, Docs, Sheets, and Calendar in Google Workspace.',
    group: 'Files & documents',
    availability: 'hosted',
    auth: 'oauth',
    urlHint:
      'Google runs one server per product — https://drivemcp.googleapis.com/mcp/v1 for Drive, and gmailmcp / docsmcp / sheetsmcp / calendarmcp for the rest. Developer Preview enrolment is required.',
    defaultCategory: 'file_write',
  },
  {
    slug: 'dropbox',
    label: 'Dropbox',
    description: 'Files, folders, and sharing in Dropbox.',
    group: 'Files & documents',
    availability: 'gateway',
    urlHint: GATEWAY_HINT,
    defaultCategory: 'file_write',
  },
  {
    slug: 'box',
    label: 'Box',
    description: 'Files, folders, metadata, and Box AI in Box.',
    group: 'Files & documents',
    availability: 'hosted',
    auth: 'oauth',
    url: 'https://mcp.box.com',
    urlHint: 'A Box admin must enable the MCP integration in the Admin Console before sign-in will succeed.',
    defaultCategory: 'file_write',
  },
  {
    slug: 'notion',
    label: 'Notion',
    description: 'Pages and databases in your Notion workspace.',
    group: 'Files & documents',
    availability: 'hosted',
    auth: 'oauth',
    url: 'https://mcp.notion.com/mcp',
    defaultCategory: 'file_write',
  },
  {
    slug: 'docusign',
    label: 'Docusign',
    description: 'Envelopes, templates, and signature status in Docusign.',
    group: 'Files & documents',
    availability: 'hosted',
    auth: 'oauth',
    url: 'https://mcp.docusign.com/mcp',
    urlHint: 'The developer sandbox lives at https://mcp-d.docusign.com/mcp.',
    defaultCategory: 'file_write',
  },
  {
    slug: 'pandadoc',
    label: 'PandaDoc',
    description: 'Documents, templates, and e-signatures in PandaDoc.',
    group: 'Files & documents',
    availability: 'gateway',
    urlHint: GATEWAY_HINT,
    defaultCategory: 'file_write',
  },

  // --- CRM & sales -------------------------------------------------------------
  {
    slug: 'salesforce',
    label: 'Salesforce',
    description: 'Leads, opportunities, accounts, and cases in Salesforce.',
    group: 'CRM & sales',
    availability: 'hosted',
    auth: 'oauth',
    urlHint:
      'Salesforce hosts one server per org (Enterprise Edition and up). Enable it in Setup, then paste your org’s endpoint.',
    defaultCategory: 'record_write',
  },
  {
    slug: 'hubspot',
    label: 'HubSpot',
    description: 'Contacts, companies, deals, and tickets in HubSpot.',
    group: 'CRM & sales',
    availability: 'hosted',
    auth: 'oauth',
    url: 'https://mcp.hubspot.com',
    urlHint:
      'HubSpot does not register clients automatically — create an MCP auth app in HubSpot first, then enter its client ID and secret below.',
    defaultCategory: 'record_write',
  },
  {
    slug: 'pipedrive',
    label: 'Pipedrive',
    description: 'Deals, contacts, and activities in Pipedrive.',
    group: 'CRM & sales',
    availability: 'gateway',
    urlHint: GATEWAY_HINT,
    defaultCategory: 'record_write',
  },
  {
    slug: 'zoho_crm',
    label: 'Zoho CRM',
    description: 'Leads, contacts, and deals in Zoho CRM.',
    group: 'CRM & sales',
    availability: 'gateway',
    urlHint: GATEWAY_HINT,
    defaultCategory: 'record_write',
  },
  {
    slug: 'attio',
    label: 'Attio',
    description: 'Records, lists, and notes in Attio.',
    group: 'CRM & sales',
    availability: 'hosted',
    auth: 'oauth',
    url: 'https://mcp.attio.com/mcp',
    defaultCategory: 'record_write',
  },

  // --- Customer support --------------------------------------------------------
  {
    slug: 'zendesk',
    label: 'Zendesk',
    description: 'Tickets, users, and help-center articles in Zendesk.',
    group: 'Customer support',
    availability: 'gateway',
    urlHint:
      'Zendesk’s own MCP server is still in early access with no public endpoint — connect through a gateway for now.',
    defaultCategory: 'record_write',
  },
  {
    slug: 'intercom',
    label: 'Intercom',
    description: 'Conversations, contacts, and tickets in Intercom.',
    group: 'Customer support',
    availability: 'hosted',
    url: 'https://mcp.intercom.com/mcp',
    authHint:
      'Paste "Authorization: Bearer …" with an Intercom access token from the developer hub. EU workspaces use mcp.eu.intercom.com/mcp.',
    defaultCategory: 'record_write',
  },
  {
    slug: 'freshdesk',
    label: 'Freshdesk',
    description: 'Tickets, contacts, and canned responses in Freshdesk.',
    group: 'Customer support',
    availability: 'gateway',
    urlHint: GATEWAY_HINT,
    defaultCategory: 'record_write',
  },
  {
    slug: 'help_scout',
    label: 'Help Scout',
    description: 'Conversations and customers in Help Scout.',
    group: 'Customer support',
    availability: 'gateway',
    urlHint: GATEWAY_HINT,
    defaultCategory: 'record_write',
  },

  // --- Project management --------------------------------------------------------
  {
    slug: 'atlassian',
    label: 'Atlassian (Jira & Confluence)',
    description: 'Jira issues and Confluence pages across your Atlassian sites.',
    group: 'Project management',
    availability: 'hosted',
    auth: 'oauth',
    url: 'https://mcp.atlassian.com/v1/mcp',
    urlHint: 'The legacy /v1/sse endpoint stops working after 30 June 2026.',
    defaultCategory: 'record_write',
  },
  {
    slug: 'asana',
    label: 'Asana',
    description: 'Tasks, projects, and comments in Asana.',
    group: 'Project management',
    availability: 'hosted',
    auth: 'oauth',
    url: 'https://mcp.asana.com/v2/mcp',
    urlHint:
      'Asana does not register clients automatically — create an app in the Asana developer console first, then enter its client ID and secret below. The v1 endpoint (mcp.asana.com/sse) shuts down 5 August 2026.',
    defaultCategory: 'record_write',
  },
  {
    slug: 'monday',
    label: 'monday.com',
    description: 'Boards, items, and updates in monday.com.',
    group: 'Project management',
    availability: 'hosted',
    auth: 'oauth',
    url: 'https://mcp.monday.com/mcp',
    defaultCategory: 'record_write',
  },
  {
    slug: 'linear',
    label: 'Linear',
    description: 'Issues, projects, and cycles in Linear.',
    group: 'Project management',
    availability: 'hosted',
    url: 'https://mcp.linear.app/mcp',
    authHint:
      'Paste "Authorization: Bearer lin_api_…" with a personal API key from Linear settings, or switch to OAuth sign-in. A read-only endpoint lives at mcp.linear.app/mcp/readonly.',
    defaultCategory: 'record_write',
  },
  {
    slug: 'clickup',
    label: 'ClickUp',
    description: 'Tasks, lists, and docs in ClickUp.',
    group: 'Project management',
    availability: 'gateway',
    urlHint: GATEWAY_HINT,
    defaultCategory: 'record_write',
  },
  {
    slug: 'trello',
    label: 'Trello',
    description: 'Boards, cards, and checklists in Trello.',
    group: 'Project management',
    availability: 'gateway',
    urlHint: GATEWAY_HINT,
    defaultCategory: 'record_write',
  },
  {
    slug: 'airtable',
    label: 'Airtable',
    description: 'Bases, tables, and records in Airtable.',
    group: 'Project management',
    availability: 'hosted',
    url: 'https://mcp.airtable.com/mcp',
    authHint:
      'Paste "Authorization: Bearer pat…" with a personal access token from airtable.com/create/tokens, or switch to OAuth sign-in.',
    defaultCategory: 'record_write',
  },
  {
    slug: 'smartsheet',
    label: 'Smartsheet',
    description: 'Sheets, rows, and reports in Smartsheet.',
    group: 'Project management',
    availability: 'gateway',
    urlHint: GATEWAY_HINT,
    defaultCategory: 'record_write',
  },

  // --- Field service ---------------------------------------------------------
  {
    slug: 'servicetitan',
    label: 'ServiceTitan',
    description: 'Jobs, customers, estimates, and dispatch in ServiceTitan.',
    group: 'Field service',
    availability: 'gateway',
    urlHint: GATEWAY_HINT,
    defaultCategory: 'record_write',
  },
  {
    slug: 'jobber',
    label: 'Jobber',
    description: 'Clients, quotes, jobs, and invoices in Jobber.',
    group: 'Field service',
    availability: 'gateway',
    urlHint: GATEWAY_HINT,
    defaultCategory: 'record_write',
  },
  {
    slug: 'housecall_pro',
    label: 'Housecall Pro',
    description: 'Customers, jobs, and schedules in Housecall Pro.',
    group: 'Field service',
    availability: 'gateway',
    urlHint: GATEWAY_HINT,
    defaultCategory: 'record_write',
  },
  {
    slug: 'servicem8',
    label: 'ServiceM8',
    description: 'Jobs, clients, and staff schedules in ServiceM8.',
    group: 'Field service',
    availability: 'gateway',
    urlHint: GATEWAY_HINT,
    defaultCategory: 'record_write',
  },

  // --- HR & payroll ------------------------------------------------------------
  {
    slug: 'gusto',
    label: 'Gusto',
    description: 'Employees, time off, and payroll records in Gusto (read-only).',
    group: 'HR & payroll',
    availability: 'hosted',
    auth: 'oauth',
    url: 'https://mcp.api.gusto.com',
    defaultCategory: 'record_write',
  },
  {
    slug: 'bamboohr',
    label: 'BambooHR',
    description: 'Employee records and time off in BambooHR.',
    group: 'HR & payroll',
    availability: 'gateway',
    urlHint: GATEWAY_HINT,
    defaultCategory: 'record_write',
  },
  {
    slug: 'rippling',
    label: 'Rippling',
    description: 'Employees, devices, and apps in Rippling.',
    group: 'HR & payroll',
    availability: 'gateway',
    urlHint: GATEWAY_HINT,
    defaultCategory: 'record_write',
  },
  {
    slug: 'adp',
    label: 'ADP',
    description: 'Workforce and payroll data in ADP.',
    group: 'HR & payroll',
    availability: 'gateway',
    urlHint: GATEWAY_HINT,
    defaultCategory: 'record_write',
  },

  // --- Commerce & marketing ------------------------------------------------------
  {
    slug: 'shopify',
    label: 'Shopify',
    description: 'Storefront catalog, cart, and order lookups for your Shopify store.',
    group: 'Commerce & marketing',
    availability: 'hosted',
    urlHint:
      'Your store’s Storefront MCP endpoint — https://your-store.myshopify.com/api/mcp — needs no credential. Admin-side data (all orders, customers) is only reachable through a gateway.',
    defaultCategory: 'record_write',
  },
  {
    slug: 'mailchimp',
    label: 'Mailchimp',
    description: 'Audiences, campaigns, and automations in Mailchimp.',
    group: 'Commerce & marketing',
    availability: 'gateway',
    urlHint: GATEWAY_HINT,
    defaultCategory: 'external_email',
  },
  {
    slug: 'klaviyo',
    label: 'Klaviyo',
    description: 'Profiles, segments, and campaigns in Klaviyo.',
    group: 'Commerce & marketing',
    availability: 'hosted',
    auth: 'oauth',
    url: 'https://mcp.klaviyo.com/mcp',
    urlHint:
      'Sign in as an Owner, Admin, or Manager. Append ?read-only=true to the URL to connect without write tools.',
    defaultCategory: 'external_email',
  },
  {
    slug: 'canva',
    label: 'Canva',
    description: 'Designs, brand templates, and exports in Canva.',
    group: 'Commerce & marketing',
    availability: 'hosted',
    auth: 'oauth',
    url: 'https://mcp.canva.com/mcp',
    defaultCategory: 'file_write',
  },
  {
    slug: 'calendly',
    label: 'Calendly',
    description: 'Event types, scheduled events, and invitees in Calendly.',
    group: 'Commerce & marketing',
    availability: 'hosted',
    auth: 'oauth',
    url: 'https://mcp.calendly.com',
    defaultCategory: 'record_write',
  },
  {
    slug: 'twilio',
    label: 'Twilio',
    description: 'Messaging, phone numbers, and call records in Twilio.',
    group: 'Commerce & marketing',
    availability: 'self_host',
    urlHint:
      'Twilio’s hosted server only serves documentation. For real account access, run their official server (github.com/twilio-labs/mcp) behind an HTTP endpoint and paste that URL.',
    defaultCategory: 'phone_call',
  },

  // --- Gateways ---------------------------------------------------------------
  {
    slug: 'zapier',
    label: 'Zapier MCP',
    description: 'One connection to nearly 8,000 apps — anything above marked "via gateway" works through this.',
    group: 'Gateways',
    availability: 'hosted',
    url: 'https://mcp.zapier.com/api/v1/connect',
    authHint:
      'Create an MCP server at mcp.zapier.com, pick the app actions to expose, and paste "Authorization: Bearer …" with the connection token it gives you.',
    defaultCategory: 'record_write',
  },
  {
    slug: 'composio',
    label: 'Composio',
    description: 'A gateway to hundreds of business apps with per-tool auth and granular scopes.',
    group: 'Gateways',
    availability: 'hosted',
    urlHint:
      'Create an MCP server in the Composio dashboard (composio.dev) and paste the per-account URL it returns, plus an "x-api-key: …" header with your Composio API key.',
    defaultCategory: 'record_write',
  },
  {
    slug: 'pipedream',
    label: 'Pipedream',
    description: 'A developer-friendly gateway exposing thousands of app APIs as MCP tools.',
    group: 'Gateways',
    availability: 'hosted',
    url: 'https://remote.mcp.pipedream.net/v3',
    authHint:
      'Headers route the connection: "Authorization: Bearer …" (a token minted from your Pipedream OAuth client), plus x-pd-project-id, x-pd-environment, x-pd-external-user-id, and x-pd-app-slug.',
    defaultCategory: 'record_write',
  },
]

export const AVAILABILITY_LABELS: Record<LibraryAvailability, string> = {
  hosted: 'Vendor hosted',
  self_host: 'Self-hosted',
  gateway: 'Via gateway',
}
