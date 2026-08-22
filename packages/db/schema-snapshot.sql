-- GENERATED FILE — do not edit by hand.
--
-- The deployed schema, captured with packages/db/scripts/snapshot-schema.mjs.
-- Integration tests load this instead of declaring DDL themselves, so a test
-- can no longer describe a table more permissively than production has it.
--
-- Regenerate after changing any file below:
--   DATABASE_URL=... pnpm --filter @datahub/db db:snapshot
--
--   backend/sql/schema.sql
--   backend/sql/migrations/049_key_reports_entry_tables.sql
--   backend/sql/migrations/050_general_ledger_entries_new_columns.sql
--   packages/db/migrations/0000_better_auth_identity.sql
--   packages/db/migrations/0001_module_schema.sql
--   packages/db/migrations/0002_qoe_bridge.sql
--   packages/db/migrations/0003_dataroom_qa.sql
--   packages/db/migrations/0004_cim.sql
--   packages/db/migrations/0005_coa_recommendations.sql
--
-- source-sha256: b53a867427c53f5c265ca307a0b755418a513b4be7a82cadbacddb0a31bd8fe2
--
-- PostgreSQL database dump
--

-- Dumped from database version 16.15
-- Dumped by pg_dump version 16.14

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

-- pgcrypto omitted: gen_random_uuid() is core from PG13 and PGlite has no extension.

--
-- Name: activity_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.activity_type AS ENUM (
    'upload',
    'request',
    'approved',
    'reminder'
);

--
-- Name: approval_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.approval_status AS ENUM (
    'pending',
    'approved',
    'rejected'
);

--
-- Name: company_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.company_status AS ENUM (
    'active',
    'inactive'
);

--
-- Name: document_activity_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.document_activity_type AS ENUM (
    'view',
    'download'
);

--
-- Name: document_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.document_status AS ENUM (
    'verified',
    'under-review',
    'rejected'
);

--
-- Name: reminder_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.reminder_status AS ENUM (
    'active',
    'done'
);

--
-- Name: request_category; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.request_category AS ENUM (
    'Finance',
    'Legal',
    'Compliance',
    'HR',
    'Tax',
    'M&A',
    'Other'
);

--
-- Name: request_priority; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.request_priority AS ENUM (
    'high',
    'medium',
    'low',
    'critical'
);

--
-- Name: request_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.request_status AS ENUM (
    'pending',
    'in-review',
    'completed',
    'blocked'
);

--
-- Name: response_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.response_type AS ENUM (
    'Upload',
    'Narrative',
    'Both'
);

--
-- Name: user_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.user_role AS ENUM (
    'admin',
    'broker',
    'buyer'
);

--
-- Name: user_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.user_status AS ENUM (
    'active',
    'inactive'
);

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: account; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account (
    id text NOT NULL,
    account_id text NOT NULL,
    provider_id text NOT NULL,
    user_id text NOT NULL,
    access_token text,
    refresh_token text,
    id_token text,
    access_token_expires_at timestamp with time zone,
    refresh_token_expires_at timestamp with time zone,
    scope text,
    password text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: activity_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.activity_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    type public.activity_type NOT NULL,
    message text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: auth_user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_user (
    id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    email_verified boolean DEFAULT true NOT NULL,
    image text,
    role public.user_role DEFAULT 'buyer'::public.user_role NOT NULL,
    company_id text,
    status public.user_status DEFAULT 'active'::public.user_status NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: balance_sheet_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.balance_sheet_entries (
    id bigint NOT NULL,
    version_id uuid NOT NULL,
    company_id uuid NOT NULL,
    source_file_id uuid NOT NULL,
    as_of_date date NOT NULL,
    fiscal_year integer NOT NULL,
    account_name text NOT NULL,
    account_number text,
    account_type text,
    section text,
    amount numeric(18,2) DEFAULT 0 NOT NULL,
    hierarchy_level integer DEFAULT 0,
    parent_account_id text,
    sort_order integer DEFAULT 0,
    is_total boolean DEFAULT false,
    row_hash text,
    extracted_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    sub_section text,
    coa_id uuid,
    is_generated boolean DEFAULT false NOT NULL
);

--
-- Name: balance_sheet_entries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.balance_sheet_entries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: balance_sheet_entries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.balance_sheet_entries_id_seq OWNED BY public.balance_sheet_entries.id;

--
-- Name: bank_statement_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bank_statement_entries (
    id bigint NOT NULL,
    version_id uuid NOT NULL,
    company_id uuid NOT NULL,
    source_file_id uuid NOT NULL,
    statement_date date NOT NULL,
    statement_month date NOT NULL,
    bank_account text NOT NULL,
    bank_name text,
    account_type text,
    transaction_date date NOT NULL,
    description text,
    reference text,
    amount numeric(18,2) DEFAULT 0 NOT NULL,
    transaction_type text,
    running_balance numeric(18,2),
    extracted_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: bank_statement_entries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bank_statement_entries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: bank_statement_entries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.bank_statement_entries_id_seq OWNED BY public.bank_statement_entries.id;

--
-- Name: bank_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bank_transactions (
    id bigint NOT NULL,
    txn_date date NOT NULL,
    client_id uuid,
    narration text,
    amount numeric(14,2) NOT NULL
);

--
-- Name: bank_transactions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bank_transactions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: bank_transactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.bank_transactions_id_seq OWNED BY public.bank_transactions.id;

--
-- Name: broker_team_invites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.broker_team_invites (
    team_owner_id uuid NOT NULL,
    invited_broker_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: buyer_group_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.buyer_group_members (
    group_id uuid NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: buyer_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.buyer_groups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: chart_of_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chart_of_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    version_id uuid NOT NULL,
    company_id uuid NOT NULL,
    account_number text,
    account_name text NOT NULL,
    parent_account_id uuid,
    account_type text,
    statement_type text,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    level_1 text,
    level_2 text,
    level_3 text,
    level_4 text,
    level_5 text,
    level_6 text,
    level_7 text,
    level_8 text,
    level_9 text,
    level_10 text,
    level_11 text,
    level_12 text,
    level_13 text,
    level_14 text,
    level_15 text,
    base_account text,
    hierarchy_path text,
    account_id_name text,
    classification_method text,
    original_name text,
    original_hierarchy jsonb,
    adjusted_name text,
    adjusted_hierarchy jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    ebitda_role text
);

--
-- Name: cim_block_provenance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cim_block_provenance (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    block_id uuid NOT NULL,
    source text NOT NULL,
    qa_item_id text,
    qa_response_id text,
    respondent_id uuid,
    answered_at timestamp with time zone,
    accepted_by uuid,
    accepted_at timestamp with time zone DEFAULT now() NOT NULL,
    outcome text DEFAULT 'accepted'::text NOT NULL,
    raw_answer text,
    CONSTRAINT cim_block_provenance_outcome_check CHECK ((outcome = ANY (ARRAY['accepted'::text, 'discarded'::text]))),
    CONSTRAINT cim_block_provenance_source_check CHECK ((source = ANY (ARRAY['qa_answer'::text, 'loader'::text, 'autofill'::text, 'broker'::text])))
);

--
-- Name: cim_blocks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cim_blocks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    version_id uuid NOT NULL,
    slide_id uuid NOT NULL,
    block_key text NOT NULL,
    kind text DEFAULT 'text'::text NOT NULL,
    label text,
    content jsonb DEFAULT '{}'::jsonb NOT NULL,
    content_class text DEFAULT 'deal'::text NOT NULL,
    content_class_locked boolean DEFAULT false NOT NULL,
    populated_by text,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cim_blocks_content_class_check CHECK ((content_class = ANY (ARRAY['deal'::text, 'firm_boilerplate'::text]))),
    CONSTRAINT cim_blocks_kind_check CHECK ((kind = ANY (ARRAY['text'::text, 'image'::text, 'table'::text, 'chart'::text, 'repeatable'::text]))),
    CONSTRAINT cim_blocks_populated_by_check CHECK (((populated_by IS NULL) OR (populated_by = ANY (ARRAY['author'::text, 'answer'::text, 'loader'::text, 'autofill'::text]))))
);

--
-- Name: cim_decks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cim_decks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    name text NOT NULL,
    template_key text DEFAULT 'source-38'::text NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);

--
-- Name: cim_publications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cim_publications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    version_id uuid NOT NULL,
    upload_id uuid,
    document_id uuid,
    sha256 text NOT NULL,
    page_count integer,
    byte_size bigint,
    published_by uuid,
    published_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: cim_question_library; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cim_question_library (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scope text DEFAULT 'system'::text NOT NULL,
    owner_id uuid,
    section_key text NOT NULL,
    layout_key text,
    block_key_pattern text,
    question_text text NOT NULL,
    help_text text,
    sort_order integer DEFAULT 0 NOT NULL,
    archived_at timestamp with time zone,
    CONSTRAINT cim_question_library_scope_check CHECK ((scope = ANY (ARRAY['system'::text, 'firm'::text, 'user'::text])))
);

--
-- Name: cim_sections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cim_sections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    version_id uuid NOT NULL,
    section_key text NOT NULL,
    title text NOT NULL,
    sort_order integer NOT NULL
);

--
-- Name: cim_slides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cim_slides (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    version_id uuid NOT NULL,
    section_id uuid NOT NULL,
    slide_class text DEFAULT 'qualitative'::text NOT NULL,
    layout_key text NOT NULL,
    slide_no integer NOT NULL,
    sort_order integer NOT NULL,
    CONSTRAINT cim_slides_slide_class_check CHECK ((slide_class = ANY (ARRAY['qualitative'::text, 'financial_exhibit'::text])))
);

--
-- Name: cim_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cim_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    deck_id uuid NOT NULL,
    version_no integer NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    cover jsonb DEFAULT '{}'::jsonb NOT NULL,
    theme jsonb DEFAULT '{}'::jsonb NOT NULL,
    approved_by uuid,
    approved_at timestamp with time zone,
    published_by uuid,
    published_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cim_versions_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'in_review'::text, 'seller_approved'::text, 'published'::text, 'archived'::text])))
);

--
-- Name: coa_account_adjustments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.coa_account_adjustments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    version_id uuid NOT NULL,
    company_id uuid,
    field_changed text NOT NULL,
    old_value jsonb,
    new_value jsonb,
    changed_by uuid,
    changed_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: coa_account_mappings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.coa_account_mappings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    version_id uuid NOT NULL,
    company_id uuid NOT NULL,
    account_id uuid,
    source_table text NOT NULL,
    source_account_name text NOT NULL,
    source_account_number text,
    normalized_name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: coa_classification_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.coa_classification_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    version_id uuid NOT NULL,
    company_id uuid,
    classification_method text,
    hierarchy_snapshot jsonb,
    source text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: coa_hierarchy_levels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.coa_hierarchy_levels (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    level_number integer NOT NULL,
    statement_type text,
    parent_label text,
    label text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    is_standard boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: companies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.companies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    industry text NOT NULL,
    status public.company_status DEFAULT 'active'::public.company_status NOT NULL,
    since date,
    logo text,
    contact_name text,
    contact_email text,
    contact_phone text,
    data_source_type text,
    quickbooks_connected boolean DEFAULT false NOT NULL,
    manual_upload_active boolean DEFAULT false NOT NULL,
    profit_metric text DEFAULT 'adjusted_ebitda'::text NOT NULL,
    last_source_switch_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    project_name text,
    market_rate_replacement_salary numeric(18,2)
);

--
-- Name: company_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.company_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    sender_id uuid NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: direct_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.direct_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    sender_id uuid NOT NULL,
    recipient_id uuid NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: document_activity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_activity (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    document_id uuid NOT NULL,
    user_id uuid NOT NULL,
    activity_type public.document_activity_type NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    actor_id uuid,
    action text,
    at timestamp with time zone DEFAULT now()
);

--
-- Name: document_comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_comments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    document_id uuid NOT NULL,
    company_id uuid NOT NULL,
    version_id uuid,
    parent_id uuid,
    body text NOT NULL,
    visibility text DEFAULT 'internal'::text NOT NULL,
    page_number integer,
    author_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT document_comments_visibility_check CHECK ((visibility = ANY (ARRAY['internal'::text, 'shared'::text])))
);

--
-- Name: document_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    document_id uuid NOT NULL,
    version_no integer NOT NULL,
    upload_id uuid,
    file_name text NOT NULL,
    size_bytes bigint DEFAULT 0 NOT NULL,
    content_type text,
    note text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    folder_id uuid NOT NULL,
    name text NOT NULL,
    file_url text NOT NULL,
    upload_id uuid,
    size text NOT NULL,
    ext text NOT NULL,
    status public.document_status NOT NULL,
    uploaded_by uuid NOT NULL,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    current_version_id uuid,
    version_count integer DEFAULT 1 NOT NULL
);

--
-- Name: ebitda_adjustment_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ebitda_adjustment_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    type_key text NOT NULL,
    label text NOT NULL,
    description text,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: email_verifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_verifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    otp_hash text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    resend_count integer DEFAULT 0 NOT NULL,
    verified boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    verified_at timestamp with time zone
);

--
-- Name: file_references; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.file_references (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    document_id uuid NOT NULL,
    linked_module text NOT NULL,
    linked_entity_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: folder_access; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.folder_access (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    folder_id uuid NOT NULL,
    user_id uuid,
    group_id uuid,
    can_read boolean DEFAULT true NOT NULL,
    can_write boolean DEFAULT false NOT NULL,
    can_download boolean DEFAULT false NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT folder_access_subject CHECK ((((user_id IS NOT NULL) AND (group_id IS NULL)) OR ((user_id IS NULL) AND (group_id IS NOT NULL))))
);

--
-- Name: folders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.folders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    parent_id uuid,
    name text NOT NULL,
    color text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone
);

--
-- Name: general_ledger_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.general_ledger_entries (
    id bigint NOT NULL,
    version_id uuid NOT NULL,
    company_id uuid NOT NULL,
    source_file_id uuid NOT NULL,
    transaction_date date,
    fiscal_year integer,
    account_number text NOT NULL,
    account_name text NOT NULL,
    account_type text,
    description text,
    reference text,
    debit numeric(18,2) DEFAULT 0,
    credit numeric(18,2) DEFAULT 0,
    net_amount numeric(18,2) GENERATED ALWAYS AS ((debit - credit)) STORED,
    category text,
    sub_category text,
    department text,
    class text,
    location text,
    journal_type text,
    transaction_type text,
    vendor_name text,
    row_number integer,
    transaction_hash text,
    extracted_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    row_type text DEFAULT 'TRANSACTION'::text NOT NULL,
    account_section text,
    distribution_account text,
    transaction_num text,
    transaction_name text,
    memo_description text,
    split_account text,
    amount numeric(18,2),
    running_balance numeric(18,2),
    raw_row_json text,
    coa_id uuid
);

--
-- Name: general_ledger_entries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.general_ledger_entries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: general_ledger_entries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.general_ledger_entries_id_seq OWNED BY public.general_ledger_entries.id;

--
-- Name: group_message_reads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_message_reads (
    group_id uuid NOT NULL,
    user_id uuid NOT NULL,
    last_read_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: group_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid NOT NULL,
    sender_id uuid NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: key_report_coa_hierarchy_recommendations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.key_report_coa_hierarchy_recommendations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    version_id uuid NOT NULL,
    company_id uuid NOT NULL,
    account_id uuid NOT NULL,
    current_hierarchy jsonb NOT NULL,
    current_account_type text,
    current_statement_type text,
    kind text DEFAULT 'ROLLUP_INSERT'::text NOT NULL,
    recommended_hierarchy jsonb,
    recommended_rollup text NOT NULL,
    recommended_parent text,
    recommended_account_type text,
    recommended_statement_type text,
    confidence numeric,
    confidence_band text,
    source text,
    impact text,
    reason text,
    ai_model text,
    status text DEFAULT 'pending'::text NOT NULL,
    rejection_reason text,
    decided_at timestamp with time zone,
    decided_by uuid,
    applied_at timestamp with time zone,
    applied_hierarchy jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT coa_reco_confidence_band_check CHECK (((confidence_band IS NULL) OR (confidence_band = ANY (ARRAY['HIGH'::text, 'MEDIUM'::text, 'LOW'::text])))),
    CONSTRAINT coa_reco_impact_check CHECK (((impact IS NULL) OR (impact = ANY (ARRAY['CLASSIFICATION'::text, 'PRESENTATION'::text, 'BALANCE_SHEET_SECTION'::text, 'OPERATING_RESULT'::text])))),
    CONSTRAINT coa_reco_kind_check CHECK ((kind = ANY (ARRAY['ROLLUP_INSERT'::text, 'HIERARCHY_MOVE'::text, 'RECLASSIFY'::text]))),
    CONSTRAINT coa_reco_reclassify_type_check CHECK ((((kind = 'RECLASSIFY'::text) AND (recommended_account_type IS NOT NULL) AND (recommended_account_type = ANY (ARRAY['income'::text, 'cogs'::text, 'expense'::text, 'asset'::text, 'liability'::text, 'equity'::text]))) OR ((kind <> 'RECLASSIFY'::text) AND (recommended_account_type IS NULL)))),
    CONSTRAINT coa_reco_source_check CHECK (((source IS NULL) OR (source = ANY (ARRAY['DOCUMENT_MATCH'::text, 'AI_REASONABLENESS'::text])))),
    CONSTRAINT coa_reco_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'applied'::text, 'rejected'::text, 'accepted'::text, 'ignored'::text])))
);

--
-- Name: key_report_file_mappings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.key_report_file_mappings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    version_id uuid NOT NULL,
    company_id uuid NOT NULL,
    report_category text NOT NULL,
    document_id uuid,
    upload_id uuid,
    file_name text,
    year integer,
    status text DEFAULT 'linked'::text NOT NULL,
    linked_by uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    extracted_rows integer DEFAULT 0,
    extraction_status text DEFAULT 'pending'::text,
    extraction_error text,
    last_extracted_at timestamp with time zone
);

--
-- Name: key_report_sync_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.key_report_sync_logs (
    id bigint NOT NULL,
    version_id uuid NOT NULL,
    company_id uuid NOT NULL,
    sync_status text DEFAULT 'started'::text NOT NULL,
    sync_started_at timestamp with time zone DEFAULT now() NOT NULL,
    sync_completed_at timestamp with time zone,
    error_message text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: key_report_sync_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.key_report_sync_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: key_report_sync_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.key_report_sync_logs_id_seq OWNED BY public.key_report_sync_logs.id;

--
-- Name: key_report_validation_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.key_report_validation_results (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    version_id uuid NOT NULL,
    company_id uuid NOT NULL,
    data_type text NOT NULL,
    year integer,
    status text NOT NULL,
    severity text NOT NULL,
    message text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: key_report_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.key_report_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    version_number integer NOT NULL,
    version_name text,
    status text DEFAULT 'draft'::text NOT NULL,
    is_active boolean DEFAULT false NOT NULL,
    resolved_batch_id uuid,
    resolved_dataset_version integer,
    last_synced_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    updated_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: manual_gl_balance_sheet_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.manual_gl_balance_sheet_lines (
    id bigint NOT NULL,
    company_id uuid NOT NULL,
    batch_id uuid NOT NULL,
    sheet_type text NOT NULL,
    as_of_date date,
    section text NOT NULL,
    account_name text NOT NULL,
    amount numeric(18,2) DEFAULT 0 NOT NULL,
    source_file text,
    source_upload_id uuid,
    row_number integer,
    line_hash text NOT NULL,
    source_type text DEFAULT 'manual_gl_upload'::text NOT NULL,
    source_switch_version timestamp with time zone,
    upload_session_id uuid,
    staged_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: manual_gl_balance_sheet_lines_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.manual_gl_balance_sheet_lines_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: manual_gl_balance_sheet_lines_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.manual_gl_balance_sheet_lines_id_seq OWNED BY public.manual_gl_balance_sheet_lines.id;

--
-- Name: manual_gl_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.manual_gl_batches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    source text DEFAULT 'manual_gl'::text NOT NULL,
    source_type text DEFAULT 'manual_gl_upload'::text NOT NULL,
    source_switch_version timestamp with time zone DEFAULT now() NOT NULL,
    upload_session_id uuid DEFAULT gen_random_uuid(),
    staged_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'staged'::text NOT NULL,
    batch_name text,
    created_by uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: manual_gl_staged_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.manual_gl_staged_transactions (
    id bigint NOT NULL,
    company_id uuid NOT NULL,
    batch_id uuid NOT NULL,
    transaction_id text NOT NULL,
    fiscal_year integer,
    txn_date date,
    account_number text,
    account_name text NOT NULL,
    account_type text,
    category text,
    sub_category text,
    debit numeric(18,2) DEFAULT 0 NOT NULL,
    credit numeric(18,2) DEFAULT 0 NOT NULL,
    net_amount numeric(18,2) DEFAULT 0 NOT NULL,
    class text,
    department text,
    location text,
    journal_type text,
    transaction_type text,
    reference text,
    description text,
    source_file text,
    source_upload_id uuid,
    row_number integer,
    transaction_hash text NOT NULL,
    source_type text DEFAULT 'manual_gl_upload'::text NOT NULL,
    source_switch_version timestamp with time zone,
    upload_session_id uuid,
    staged_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: manual_gl_staged_transactions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.manual_gl_staged_transactions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: manual_gl_staged_transactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.manual_gl_staged_transactions_id_seq OWNED BY public.manual_gl_staged_transactions.id;

--
-- Name: message_group_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_group_members (
    group_id uuid NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: message_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_groups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    name text NOT NULL,
    group_type text NOT NULL,
    buyer_user_id uuid,
    auto_created boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: profit_loss_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profit_loss_entries (
    id bigint NOT NULL,
    version_id uuid NOT NULL,
    company_id uuid NOT NULL,
    source_file_id uuid NOT NULL,
    fiscal_year integer NOT NULL,
    account_name text NOT NULL,
    account_number text,
    account_type text,
    category text,
    sub_category text,
    amount numeric(18,2) DEFAULT 0 NOT NULL,
    hierarchy_level integer DEFAULT 0,
    parent_account_id text,
    sort_order integer DEFAULT 0,
    is_total boolean DEFAULT false,
    row_hash text,
    extracted_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: profit_loss_entries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.profit_loss_entries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: profit_loss_entries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.profit_loss_entries_id_seq OWNED BY public.profit_loss_entries.id;

--
-- Name: qa_assignees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qa_assignees (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    item_id uuid NOT NULL,
    user_id uuid NOT NULL,
    kind text DEFAULT 'requestee'::text NOT NULL,
    assigned_by uuid,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL,
    removed_at timestamp with time zone,
    CONSTRAINT qa_assignees_kind_check CHECK ((kind = ANY (ARRAY['requestee'::text, 'delegate'::text])))
);

--
-- Name: qa_assignment_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qa_assignment_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    item_id uuid NOT NULL,
    action text NOT NULL,
    prior_user_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    new_user_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    actor_id uuid NOT NULL,
    note text,
    at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT qa_assignment_events_action_check CHECK ((action = ANY (ARRAY['assigned'::text, 'reassigned'::text, 'delegated'::text, 'removed'::text, 'status_changed'::text])))
);

--
-- Name: qa_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qa_attachments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    item_id uuid NOT NULL,
    response_id uuid,
    document_id uuid NOT NULL,
    folder_id uuid,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: qa_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qa_categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    key text NOT NULL,
    label text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: qa_item_visibility; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qa_item_visibility (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    item_id uuid NOT NULL,
    user_id uuid,
    role_key text,
    effect text DEFAULT 'hide'::text NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT qa_item_visibility_effect_check CHECK ((effect = ANY (ARRAY['hide'::text, 'allow'::text]))),
    CONSTRAINT qa_item_visibility_subject CHECK (((user_id IS NOT NULL) <> (role_key IS NOT NULL)))
);

--
-- Name: qa_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qa_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    category_id uuid,
    reference text,
    title text NOT NULL,
    body text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    priority text DEFAULT 'medium'::text NOT NULL,
    origin text DEFAULT 'manual'::text NOT NULL,
    module_tag text DEFAULT 'Unclassified'::text NOT NULL,
    section_tag text,
    account_ref text,
    external_ref text,
    requestor_id uuid NOT NULL,
    asked_at timestamp with time zone DEFAULT now() NOT NULL,
    answered_at timestamp with time zone,
    due_date date,
    closed_at timestamp with time zone,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT qa_items_origin_check CHECK ((origin = ANY (ARRAY['manual'::text, 'qe_generator'::text, 'cim_guided'::text]))),
    CONSTRAINT qa_items_priority_check CHECK ((priority = ANY (ARRAY['critical'::text, 'high'::text, 'medium'::text, 'low'::text]))),
    CONSTRAINT qa_items_status_check CHECK ((status = ANY (ARRAY['open'::text, 'answered'::text, 'follow_up'::text, 'closed'::text])))
);

--
-- Name: qa_nominations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qa_nominations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    category_id uuid NOT NULL,
    user_id uuid NOT NULL,
    nominated_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone
);

--
-- Name: qa_presentations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qa_presentations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    item_id uuid NOT NULL,
    source_response_id uuid NOT NULL,
    body text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    is_current boolean DEFAULT true NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    author_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT qa_presentations_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text])))
);

--
-- Name: qa_responses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qa_responses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    item_id uuid NOT NULL,
    citation_ref text NOT NULL,
    kind text DEFAULT 'answer'::text NOT NULL,
    body text NOT NULL,
    author_id uuid NOT NULL,
    posted_at timestamp with time zone DEFAULT now() NOT NULL,
    supersedes_id uuid,
    answer_root_id uuid,
    answer_version integer DEFAULT 1 NOT NULL,
    is_current boolean DEFAULT true NOT NULL,
    CONSTRAINT qa_responses_kind_check CHECK ((kind = ANY (ARRAY['answer'::text, 'comment'::text, 'clarification'::text])))
);

--
-- Name: qoe_addbacks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qoe_addbacks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    version_id text NOT NULL,
    kind text NOT NULL,
    data_source text DEFAULT 'company_financials'::text NOT NULL,
    type_key text NOT NULL,
    name text NOT NULL,
    linked_account_id text,
    vendor_scope jsonb DEFAULT '[]'::jsonb NOT NULL,
    granularity text DEFAULT 'detail'::text NOT NULL,
    "values" jsonb DEFAULT '{}'::jsonb NOT NULL,
    recast_normalized_value numeric(18,2),
    group_id text,
    group_label text,
    explanation text,
    commentary text,
    qa_citation_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT qoe_addbacks_data_source_check CHECK ((data_source = ANY (ARRAY['company_financials'::text, 'tax_return'::text]))),
    CONSTRAINT qoe_addbacks_gl_sourced_needs_account CHECK (((kind <> ALL (ARRAY['pnl_account_vendor'::text, 'recast'::text])) OR (linked_account_id IS NOT NULL))),
    CONSTRAINT qoe_addbacks_granularity_check CHECK ((granularity = ANY (ARRAY['detail'::text, 'smoothed'::text]))),
    CONSTRAINT qoe_addbacks_kind_check CHECK ((kind = ANY (ARRAY['pnl_account_vendor'::text, 'balance_sheet_change'::text, 'manual_adjustment'::text, 'recast'::text]))),
    CONSTRAINT qoe_addbacks_manual_needs_explanation CHECK (((kind <> 'manual_adjustment'::text) OR ((explanation IS NOT NULL) AND (btrim(explanation) <> ''::text)))),
    CONSTRAINT qoe_addbacks_recast_needs_normalized_value CHECK (((kind <> 'recast'::text) OR (recast_normalized_value IS NOT NULL)))
);

--
-- Name: reconciliation_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reconciliation_transactions (
    id bigint NOT NULL,
    txn_date date NOT NULL,
    client_id uuid,
    amount numeric(14,2) NOT NULL,
    name text,
    transaction_type text
);

--
-- Name: reconciliation_transactions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.reconciliation_transactions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: reconciliation_transactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.reconciliation_transactions_id_seq OWNED BY public.reconciliation_transactions.id;

--
-- Name: reminders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reminders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    request_id uuid,
    title text NOT NULL,
    message text,
    due_date date NOT NULL,
    priority text DEFAULT 'medium'::text NOT NULL,
    frequency_days integer DEFAULT 2 NOT NULL,
    sent_count integer DEFAULT 0 NOT NULL,
    last_sent_at timestamp with time zone,
    next_due_at timestamp with time zone,
    status public.reminder_status DEFAULT 'active'::public.reminder_status NOT NULL,
    created_by uuid NOT NULL
);

--
-- Name: report_source_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.report_source_records (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    source_key text NOT NULL,
    source_label text DEFAULT ''::text NOT NULL,
    is_selected boolean DEFAULT false NOT NULL,
    is_available boolean DEFAULT false NOT NULL,
    is_connected boolean DEFAULT false NOT NULL,
    last_connected_at timestamp with time zone,
    last_synced_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: request_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.request_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    request_id uuid NOT NULL,
    document_id uuid NOT NULL,
    visible boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: request_narratives; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.request_narratives (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    request_id uuid NOT NULL,
    content text NOT NULL,
    updated_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: request_reminders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.request_reminders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    request_id uuid NOT NULL,
    sent_by uuid NOT NULL,
    sent_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    title text NOT NULL,
    sub_label text,
    description text NOT NULL,
    category public.request_category NOT NULL,
    response_type public.response_type NOT NULL,
    priority public.request_priority NOT NULL,
    status public.request_status NOT NULL,
    due_date date NOT NULL,
    assigned_to uuid,
    visible boolean DEFAULT true NOT NULL,
    created_by uuid NOT NULL,
    reminder_frequency_days integer DEFAULT 2 NOT NULL,
    submission_source text DEFAULT 'broker'::text NOT NULL,
    approval_status text DEFAULT 'approved'::text NOT NULL,
    approved_by uuid,
    approved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version text NOT NULL,
    checksum text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.session (
    id text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    token text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    ip_address text,
    user_agent text,
    user_id text NOT NULL
);

--
-- Name: tax_return_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tax_return_entries (
    id bigint NOT NULL,
    version_id uuid NOT NULL,
    company_id uuid NOT NULL,
    source_file_id uuid NOT NULL,
    tax_year integer NOT NULL,
    form_type text,
    field_name text NOT NULL,
    field_label text,
    field_value text,
    field_amount numeric(18,2),
    line_number text,
    schedule text,
    section text,
    extracted_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: tax_return_entries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tax_return_entries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: tax_return_entries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tax_return_entries_id_seq OWNED BY public.tax_return_entries.id;

--
-- Name: upload_chunks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.upload_chunks (
    session_id uuid NOT NULL,
    chunk_index integer NOT NULL,
    size_bytes integer NOT NULL,
    data bytea NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: upload_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.upload_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid,
    folder_id uuid,
    document_id uuid,
    file_name text NOT NULL,
    content_type text NOT NULL,
    total_bytes bigint NOT NULL,
    chunk_size integer NOT NULL,
    total_chunks integer NOT NULL,
    received_count integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    upload_id uuid,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '06:00:00'::interval) NOT NULL,
    CONSTRAINT upload_sessions_status_check CHECK ((status = ANY (ARRAY['open'::text, 'completed'::text, 'aborted'::text])))
);

--
-- Name: uploads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.uploads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    file_name text NOT NULL,
    content_type text NOT NULL,
    size_bytes integer NOT NULL,
    data bytea NOT NULL,
    prefix text,
    uploaded_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: user_companies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_companies (
    user_id uuid NOT NULL,
    company_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: user_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_preferences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    pref_key text NOT NULL,
    pref_value jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    phone text,
    password_hash text NOT NULL,
    role public.user_role NOT NULL,
    company_id uuid,
    status public.user_status DEFAULT 'active'::public.user_status NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    sub_role text,
    designation text,
    buyer_company_name text,
    parent_user_id uuid,
    date_of_birth date,
    occupation text,
    address text,
    broker_company text
);

--
-- Name: verification; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.verification (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: workspace_page_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_page_state (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    page_key text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: balance_sheet_entries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.balance_sheet_entries ALTER COLUMN id SET DEFAULT nextval('public.balance_sheet_entries_id_seq'::regclass);

--
-- Name: bank_statement_entries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bank_statement_entries ALTER COLUMN id SET DEFAULT nextval('public.bank_statement_entries_id_seq'::regclass);

--
-- Name: bank_transactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bank_transactions ALTER COLUMN id SET DEFAULT nextval('public.bank_transactions_id_seq'::regclass);

--
-- Name: general_ledger_entries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.general_ledger_entries ALTER COLUMN id SET DEFAULT nextval('public.general_ledger_entries_id_seq'::regclass);

--
-- Name: key_report_sync_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.key_report_sync_logs ALTER COLUMN id SET DEFAULT nextval('public.key_report_sync_logs_id_seq'::regclass);

--
-- Name: manual_gl_balance_sheet_lines id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manual_gl_balance_sheet_lines ALTER COLUMN id SET DEFAULT nextval('public.manual_gl_balance_sheet_lines_id_seq'::regclass);

--
-- Name: manual_gl_staged_transactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manual_gl_staged_transactions ALTER COLUMN id SET DEFAULT nextval('public.manual_gl_staged_transactions_id_seq'::regclass);

--
-- Name: profit_loss_entries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profit_loss_entries ALTER COLUMN id SET DEFAULT nextval('public.profit_loss_entries_id_seq'::regclass);

--
-- Name: reconciliation_transactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reconciliation_transactions ALTER COLUMN id SET DEFAULT nextval('public.reconciliation_transactions_id_seq'::regclass);

--
-- Name: tax_return_entries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_return_entries ALTER COLUMN id SET DEFAULT nextval('public.tax_return_entries_id_seq'::regclass);

--
-- Name: account account_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account
    ADD CONSTRAINT account_pkey PRIMARY KEY (id);

--
-- Name: activity_log activity_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_log
    ADD CONSTRAINT activity_log_pkey PRIMARY KEY (id);

--
-- Name: auth_user auth_user_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_user
    ADD CONSTRAINT auth_user_email_key UNIQUE (email);

--
-- Name: auth_user auth_user_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_user
    ADD CONSTRAINT auth_user_pkey PRIMARY KEY (id);

--
-- Name: balance_sheet_entries balance_sheet_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.balance_sheet_entries
    ADD CONSTRAINT balance_sheet_entries_pkey PRIMARY KEY (id);

--
-- Name: bank_statement_entries bank_statement_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bank_statement_entries
    ADD CONSTRAINT bank_statement_entries_pkey PRIMARY KEY (id);

--
-- Name: bank_transactions bank_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bank_transactions
    ADD CONSTRAINT bank_transactions_pkey PRIMARY KEY (id);

--
-- Name: broker_team_invites broker_team_invites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.broker_team_invites
    ADD CONSTRAINT broker_team_invites_pkey PRIMARY KEY (team_owner_id, invited_broker_id);

--
-- Name: buyer_group_members buyer_group_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.buyer_group_members
    ADD CONSTRAINT buyer_group_members_pkey PRIMARY KEY (group_id, user_id);

--
-- Name: buyer_groups buyer_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.buyer_groups
    ADD CONSTRAINT buyer_groups_pkey PRIMARY KEY (id);

--
-- Name: chart_of_accounts chart_of_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chart_of_accounts
    ADD CONSTRAINT chart_of_accounts_pkey PRIMARY KEY (id);

--
-- Name: cim_block_provenance cim_block_provenance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cim_block_provenance
    ADD CONSTRAINT cim_block_provenance_pkey PRIMARY KEY (id);

--
-- Name: cim_blocks cim_blocks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cim_blocks
    ADD CONSTRAINT cim_blocks_pkey PRIMARY KEY (id);

--
-- Name: cim_blocks cim_blocks_version_id_block_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cim_blocks
    ADD CONSTRAINT cim_blocks_version_id_block_key_key UNIQUE (version_id, block_key);

--
-- Name: cim_decks cim_decks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cim_decks
    ADD CONSTRAINT cim_decks_pkey PRIMARY KEY (id);

--
-- Name: cim_publications cim_publications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cim_publications
    ADD CONSTRAINT cim_publications_pkey PRIMARY KEY (id);

--
-- Name: cim_publications cim_publications_version_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cim_publications
    ADD CONSTRAINT cim_publications_version_id_key UNIQUE (version_id);

--
-- Name: cim_question_library cim_question_library_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cim_question_library
    ADD CONSTRAINT cim_question_library_pkey PRIMARY KEY (id);

--
-- Name: cim_sections cim_sections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cim_sections
    ADD CONSTRAINT cim_sections_pkey PRIMARY KEY (id);

--
-- Name: cim_sections cim_sections_version_id_section_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cim_sections
    ADD CONSTRAINT cim_sections_version_id_section_key_key UNIQUE (version_id, section_key);

--
-- Name: cim_slides cim_slides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cim_slides
    ADD CONSTRAINT cim_slides_pkey PRIMARY KEY (id);

--
-- Name: cim_slides cim_slides_version_id_sort_order_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cim_slides
    ADD CONSTRAINT cim_slides_version_id_sort_order_key UNIQUE (version_id, sort_order);

--
-- Name: cim_versions cim_versions_deck_id_version_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cim_versions
    ADD CONSTRAINT cim_versions_deck_id_version_no_key UNIQUE (deck_id, version_no);

--
-- Name: cim_versions cim_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cim_versions
    ADD CONSTRAINT cim_versions_pkey PRIMARY KEY (id);

--
-- Name: coa_account_adjustments coa_account_adjustments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coa_account_adjustments
    ADD CONSTRAINT coa_account_adjustments_pkey PRIMARY KEY (id);

--
-- Name: coa_account_mappings coa_account_mappings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coa_account_mappings
    ADD CONSTRAINT coa_account_mappings_pkey PRIMARY KEY (id);

--
-- Name: coa_classification_history coa_classification_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coa_classification_history
    ADD CONSTRAINT coa_classification_history_pkey PRIMARY KEY (id);

--
-- Name: coa_hierarchy_levels coa_hierarchy_levels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coa_hierarchy_levels
    ADD CONSTRAINT coa_hierarchy_levels_pkey PRIMARY KEY (id);

--
-- Name: companies companies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_pkey PRIMARY KEY (id);

--
-- Name: company_messages company_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_messages
    ADD CONSTRAINT company_messages_pkey PRIMARY KEY (id);

--
-- Name: direct_messages direct_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.direct_messages
    ADD CONSTRAINT direct_messages_pkey PRIMARY KEY (id);

--
-- Name: document_activity document_activity_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_activity
    ADD CONSTRAINT document_activity_pkey PRIMARY KEY (id);

--
-- Name: document_comments document_comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_comments
    ADD CONSTRAINT document_comments_pkey PRIMARY KEY (id);

--
-- Name: document_versions document_versions_document_id_version_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_document_id_version_no_key UNIQUE (document_id, version_no);

--
-- Name: document_versions document_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_pkey PRIMARY KEY (id);

--
-- Name: documents documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_pkey PRIMARY KEY (id);

--
-- Name: ebitda_adjustment_types ebitda_adjustment_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ebitda_adjustment_types
    ADD CONSTRAINT ebitda_adjustment_types_pkey PRIMARY KEY (id);

--
-- Name: ebitda_adjustment_types ebitda_adjustment_types_type_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ebitda_adjustment_types
    ADD CONSTRAINT ebitda_adjustment_types_type_key_key UNIQUE (type_key);

--
-- Name: email_verifications email_verifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_verifications
    ADD CONSTRAINT email_verifications_pkey PRIMARY KEY (id);

--
-- Name: file_references file_references_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_references
    ADD CONSTRAINT file_references_pkey PRIMARY KEY (id);

--
-- Name: folder_access folder_access_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.folder_access
    ADD CONSTRAINT folder_access_pkey PRIMARY KEY (id);

--
-- Name: folders folders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.folders
    ADD CONSTRAINT folders_pkey PRIMARY KEY (id);

--
-- Name: general_ledger_entries general_ledger_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.general_ledger_entries
    ADD CONSTRAINT general_ledger_entries_pkey PRIMARY KEY (id);

--
-- Name: group_message_reads group_message_reads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_message_reads
    ADD CONSTRAINT group_message_reads_pkey PRIMARY KEY (group_id, user_id);

--
-- Name: group_messages group_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_messages
    ADD CONSTRAINT group_messages_pkey PRIMARY KEY (id);

--
-- Name: key_report_coa_hierarchy_recommendations key_report_coa_hierarchy_reco_version_id_account_id_recomme_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.key_report_coa_hierarchy_recommendations
    ADD CONSTRAINT key_report_coa_hierarchy_reco_version_id_account_id_recomme_key UNIQUE (version_id, account_id, recommended_rollup);

--
-- Name: key_report_coa_hierarchy_recommendations key_report_coa_hierarchy_recommendations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.key_report_coa_hierarchy_recommendations
    ADD CONSTRAINT key_report_coa_hierarchy_recommendations_pkey PRIMARY KEY (id);

--
-- Name: key_report_file_mappings key_report_file_mappings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.key_report_file_mappings
    ADD CONSTRAINT key_report_file_mappings_pkey PRIMARY KEY (id);

--
-- Name: key_report_sync_logs key_report_sync_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.key_report_sync_logs
    ADD CONSTRAINT key_report_sync_logs_pkey PRIMARY KEY (id);

--
-- Name: key_report_validation_results key_report_validation_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.key_report_validation_results
    ADD CONSTRAINT key_report_validation_results_pkey PRIMARY KEY (id);

--
-- Name: key_report_versions key_report_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.key_report_versions
    ADD CONSTRAINT key_report_versions_pkey PRIMARY KEY (id);

--
-- Name: manual_gl_balance_sheet_lines manual_gl_balance_sheet_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manual_gl_balance_sheet_lines
    ADD CONSTRAINT manual_gl_balance_sheet_lines_pkey PRIMARY KEY (id);

--
-- Name: manual_gl_batches manual_gl_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manual_gl_batches
    ADD CONSTRAINT manual_gl_batches_pkey PRIMARY KEY (id);

--
-- Name: manual_gl_staged_transactions manual_gl_staged_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manual_gl_staged_transactions
    ADD CONSTRAINT manual_gl_staged_transactions_pkey PRIMARY KEY (id);

--
-- Name: message_group_members message_group_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_group_members
    ADD CONSTRAINT message_group_members_pkey PRIMARY KEY (group_id, user_id);

--
-- Name: message_groups message_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_groups
    ADD CONSTRAINT message_groups_pkey PRIMARY KEY (id);

--
-- Name: profit_loss_entries profit_loss_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profit_loss_entries
    ADD CONSTRAINT profit_loss_entries_pkey PRIMARY KEY (id);

--
-- Name: qa_assignees qa_assignees_item_id_user_id_kind_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_assignees
    ADD CONSTRAINT qa_assignees_item_id_user_id_kind_key UNIQUE (item_id, user_id, kind);

--
-- Name: qa_assignees qa_assignees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_assignees
    ADD CONSTRAINT qa_assignees_pkey PRIMARY KEY (id);

--
-- Name: qa_assignment_events qa_assignment_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_assignment_events
    ADD CONSTRAINT qa_assignment_events_pkey PRIMARY KEY (id);

--
-- Name: qa_attachments qa_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_attachments
    ADD CONSTRAINT qa_attachments_pkey PRIMARY KEY (id);

--
-- Name: qa_attachments qa_attachments_response_id_document_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_attachments
    ADD CONSTRAINT qa_attachments_response_id_document_id_key UNIQUE (response_id, document_id);

--
-- Name: qa_categories qa_categories_company_id_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_categories
    ADD CONSTRAINT qa_categories_company_id_key_key UNIQUE (company_id, key);

--
-- Name: qa_categories qa_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_categories
    ADD CONSTRAINT qa_categories_pkey PRIMARY KEY (id);

--
-- Name: qa_item_visibility qa_item_visibility_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_item_visibility
    ADD CONSTRAINT qa_item_visibility_pkey PRIMARY KEY (id);

--
-- Name: qa_items qa_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_items
    ADD CONSTRAINT qa_items_pkey PRIMARY KEY (id);

--
-- Name: qa_nominations qa_nominations_category_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_nominations
    ADD CONSTRAINT qa_nominations_category_id_user_id_key UNIQUE (category_id, user_id);

--
-- Name: qa_nominations qa_nominations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_nominations
    ADD CONSTRAINT qa_nominations_pkey PRIMARY KEY (id);

--
-- Name: qa_presentations qa_presentations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_presentations
    ADD CONSTRAINT qa_presentations_pkey PRIMARY KEY (id);

--
-- Name: qa_responses qa_responses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_responses
    ADD CONSTRAINT qa_responses_pkey PRIMARY KEY (id);

--
-- Name: qoe_addbacks qoe_addbacks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qoe_addbacks
    ADD CONSTRAINT qoe_addbacks_pkey PRIMARY KEY (id);

--
-- Name: reconciliation_transactions reconciliation_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reconciliation_transactions
    ADD CONSTRAINT reconciliation_transactions_pkey PRIMARY KEY (id);

--
-- Name: reminders reminders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reminders
    ADD CONSTRAINT reminders_pkey PRIMARY KEY (id);

--
-- Name: report_source_records report_source_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_source_records
    ADD CONSTRAINT report_source_records_pkey PRIMARY KEY (id);

--
-- Name: request_documents request_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_documents
    ADD CONSTRAINT request_documents_pkey PRIMARY KEY (id);

--
-- Name: request_narratives request_narratives_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_narratives
    ADD CONSTRAINT request_narratives_pkey PRIMARY KEY (id);

--
-- Name: request_narratives request_narratives_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_narratives
    ADD CONSTRAINT request_narratives_request_id_key UNIQUE (request_id);

--
-- Name: request_reminders request_reminders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_reminders
    ADD CONSTRAINT request_reminders_pkey PRIMARY KEY (id);

--
-- Name: requests requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.requests
    ADD CONSTRAINT requests_pkey PRIMARY KEY (id);

--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);

--
-- Name: session session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_pkey PRIMARY KEY (id);

--
-- Name: session session_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_token_key UNIQUE (token);

--
-- Name: tax_return_entries tax_return_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_return_entries
    ADD CONSTRAINT tax_return_entries_pkey PRIMARY KEY (id);

--
-- Name: upload_chunks upload_chunks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_chunks
    ADD CONSTRAINT upload_chunks_pkey PRIMARY KEY (session_id, chunk_index);

--
-- Name: upload_sessions upload_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_sessions
    ADD CONSTRAINT upload_sessions_pkey PRIMARY KEY (id);

--
-- Name: uploads uploads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.uploads
    ADD CONSTRAINT uploads_pkey PRIMARY KEY (id);

--
-- Name: chart_of_accounts uq_chart_of_accounts_version_account; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chart_of_accounts
    ADD CONSTRAINT uq_chart_of_accounts_version_account UNIQUE (version_id, account_number, account_name);

--
-- Name: coa_account_mappings uq_coa_account_mappings; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coa_account_mappings
    ADD CONSTRAINT uq_coa_account_mappings UNIQUE (version_id, source_table, normalized_name, source_account_number);

--
-- Name: coa_hierarchy_levels uq_coa_hierarchy_levels; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coa_hierarchy_levels
    ADD CONSTRAINT uq_coa_hierarchy_levels UNIQUE (level_number, statement_type, parent_label, label);

--
-- Name: file_references uq_file_references_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_references
    ADD CONSTRAINT uq_file_references_unique UNIQUE (document_id, linked_module, linked_entity_id);

--
-- Name: key_report_file_mappings uq_key_report_file_mappings_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.key_report_file_mappings
    ADD CONSTRAINT uq_key_report_file_mappings_unique UNIQUE (version_id, report_category, document_id);

--
-- Name: key_report_versions uq_key_report_versions_company_number; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.key_report_versions
    ADD CONSTRAINT uq_key_report_versions_company_number UNIQUE (company_id, version_number);

--
-- Name: manual_gl_balance_sheet_lines uq_manual_gl_bs_line_hash_batch; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manual_gl_balance_sheet_lines
    ADD CONSTRAINT uq_manual_gl_bs_line_hash_batch UNIQUE (company_id, batch_id, sheet_type, line_hash);

--
-- Name: manual_gl_balance_sheet_lines uq_manual_gl_bs_line_hash_legacy; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manual_gl_balance_sheet_lines
    ADD CONSTRAINT uq_manual_gl_bs_line_hash_legacy UNIQUE (company_id, sheet_type, line_hash);

--
-- Name: manual_gl_staged_transactions uq_manual_gl_txn_hash_batch; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manual_gl_staged_transactions
    ADD CONSTRAINT uq_manual_gl_txn_hash_batch UNIQUE (company_id, batch_id, transaction_hash);

--
-- Name: manual_gl_staged_transactions uq_manual_gl_txn_hash_legacy; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manual_gl_staged_transactions
    ADD CONSTRAINT uq_manual_gl_txn_hash_legacy UNIQUE (company_id, transaction_hash);

--
-- Name: report_source_records uq_report_source_records_company_source; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_source_records
    ADD CONSTRAINT uq_report_source_records_company_source UNIQUE (company_id, source_key);

--
-- Name: user_preferences uq_user_preferences_user_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_preferences
    ADD CONSTRAINT uq_user_preferences_user_key UNIQUE (user_id, pref_key);

--
-- Name: workspace_page_state uq_workspace_page_state_company_page; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_page_state
    ADD CONSTRAINT uq_workspace_page_state_company_page UNIQUE (company_id, page_key);

--
-- Name: user_companies user_companies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_companies
    ADD CONSTRAINT user_companies_pkey PRIMARY KEY (user_id, company_id);

--
-- Name: user_preferences user_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_preferences
    ADD CONSTRAINT user_preferences_pkey PRIMARY KEY (id);

--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);

--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

--
-- Name: verification verification_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verification
    ADD CONSTRAINT verification_pkey PRIMARY KEY (id);

--
-- Name: workspace_page_state workspace_page_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_page_state
    ADD CONSTRAINT workspace_page_state_pkey PRIMARY KEY (id);

--
-- Name: account_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX account_user_id_idx ON public.account USING btree (user_id);

--
-- Name: cim_versions_one_open; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX cim_versions_one_open ON public.cim_versions USING btree (deck_id) WHERE (status = ANY (ARRAY['draft'::text, 'in_review'::text]));

--
-- Name: folders_company_parent_name_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX folders_company_parent_name_uq ON public.folders USING btree (company_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), name);

--
-- Name: idx_activity_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_activity_company ON public.activity_log USING btree (company_id);

--
-- Name: idx_balance_sheet_entries_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_balance_sheet_entries_account ON public.balance_sheet_entries USING btree (version_id, account_name, account_number);

--
-- Name: idx_balance_sheet_entries_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_balance_sheet_entries_company ON public.balance_sheet_entries USING btree (company_id, created_at DESC);

--
-- Name: idx_balance_sheet_entries_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_balance_sheet_entries_date ON public.balance_sheet_entries USING btree (version_id, as_of_date);

--
-- Name: idx_balance_sheet_entries_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_balance_sheet_entries_hash ON public.balance_sheet_entries USING btree (version_id, source_file_id, row_hash) WHERE (row_hash IS NOT NULL);

--
-- Name: idx_balance_sheet_entries_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_balance_sheet_entries_source ON public.balance_sheet_entries USING btree (source_file_id);

--
-- Name: idx_balance_sheet_entries_version_year; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_balance_sheet_entries_version_year ON public.balance_sheet_entries USING btree (version_id, fiscal_year);

--
-- Name: idx_bank_statement_entries_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bank_statement_entries_account ON public.bank_statement_entries USING btree (version_id, bank_account);

--
-- Name: idx_bank_statement_entries_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bank_statement_entries_company ON public.bank_statement_entries USING btree (company_id, created_at DESC);

--
-- Name: idx_bank_statement_entries_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bank_statement_entries_date ON public.bank_statement_entries USING btree (version_id, transaction_date);

--
-- Name: idx_bank_statement_entries_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bank_statement_entries_source ON public.bank_statement_entries USING btree (source_file_id);

--
-- Name: idx_bank_statement_entries_version_month; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bank_statement_entries_version_month ON public.bank_statement_entries USING btree (version_id, statement_month);

--
-- Name: idx_bank_transactions_client_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bank_transactions_client_id ON public.bank_transactions USING btree (client_id);

--
-- Name: idx_bs_entries_coa; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bs_entries_coa ON public.balance_sheet_entries USING btree (version_id, coa_id);

--
-- Name: idx_chart_of_accounts_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chart_of_accounts_company ON public.chart_of_accounts USING btree (company_id);

--
-- Name: idx_chart_of_accounts_method; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chart_of_accounts_method ON public.chart_of_accounts USING btree (version_id, classification_method);

--
-- Name: idx_chart_of_accounts_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chart_of_accounts_parent ON public.chart_of_accounts USING btree (parent_account_id);

--
-- Name: idx_chart_of_accounts_statement; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chart_of_accounts_statement ON public.chart_of_accounts USING btree (version_id, statement_type, account_type);

--
-- Name: idx_chart_of_accounts_version; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chart_of_accounts_version ON public.chart_of_accounts USING btree (version_id, sort_order);

--
-- Name: idx_cim_block_provenance_block; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cim_block_provenance_block ON public.cim_block_provenance USING btree (block_id);

--
-- Name: idx_cim_blocks_gaps; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cim_blocks_gaps ON public.cim_blocks USING btree (version_id, populated_by);

--
-- Name: idx_cim_decks_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cim_decks_company ON public.cim_decks USING btree (company_id, deleted_at);

--
-- Name: idx_cim_question_library_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cim_question_library_lookup ON public.cim_question_library USING btree (scope, section_key, archived_at);

--
-- Name: idx_cim_slides_section; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cim_slides_section ON public.cim_slides USING btree (section_id, sort_order);

--
-- Name: idx_coa_account_adjustments_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coa_account_adjustments_account ON public.coa_account_adjustments USING btree (account_id, changed_at DESC);

--
-- Name: idx_coa_account_adjustments_version; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coa_account_adjustments_version ON public.coa_account_adjustments USING btree (version_id, changed_at DESC);

--
-- Name: idx_coa_account_mappings_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coa_account_mappings_account ON public.coa_account_mappings USING btree (account_id);

--
-- Name: idx_coa_account_mappings_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coa_account_mappings_lookup ON public.coa_account_mappings USING btree (version_id, normalized_name);

--
-- Name: idx_coa_classification_history_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coa_classification_history_account ON public.coa_classification_history USING btree (account_id, created_at DESC);

--
-- Name: idx_coa_classification_history_version; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coa_classification_history_version ON public.coa_classification_history USING btree (version_id, created_at DESC);

--
-- Name: idx_coa_hierarchy_levels_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coa_hierarchy_levels_lookup ON public.coa_hierarchy_levels USING btree (level_number, statement_type);

--
-- Name: idx_coa_reco_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coa_reco_account ON public.key_report_coa_hierarchy_recommendations USING btree (account_id);

--
-- Name: idx_coa_reco_band; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coa_reco_band ON public.key_report_coa_hierarchy_recommendations USING btree (version_id, confidence_band);

--
-- Name: idx_coa_reco_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coa_reco_status ON public.key_report_coa_hierarchy_recommendations USING btree (version_id, status);

--
-- Name: idx_coa_reco_version; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coa_reco_version ON public.key_report_coa_hierarchy_recommendations USING btree (version_id);

--
-- Name: idx_company_messages_company_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_company_messages_company_created ON public.company_messages USING btree (company_id, created_at DESC);

--
-- Name: idx_company_messages_sender; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_company_messages_sender ON public.company_messages USING btree (sender_id);

--
-- Name: idx_direct_messages_company_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_direct_messages_company_created ON public.direct_messages USING btree (company_id, created_at DESC);

--
-- Name: idx_direct_messages_recipient_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_direct_messages_recipient_company ON public.direct_messages USING btree (recipient_id, company_id);

--
-- Name: idx_direct_messages_sender_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_direct_messages_sender_company ON public.direct_messages USING btree (sender_id, company_id);

--
-- Name: idx_document_activity_document; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_activity_document ON public.document_activity USING btree (document_id);

--
-- Name: idx_document_comments_doc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_comments_doc ON public.document_comments USING btree (document_id, created_at);

--
-- Name: idx_document_versions_doc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_versions_doc ON public.document_versions USING btree (document_id, version_no DESC);

--
-- Name: idx_documents_folder_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_folder_id ON public.documents USING btree (folder_id);

--
-- Name: idx_documents_upload_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_upload_id ON public.documents USING btree (upload_id);

--
-- Name: idx_email_verifications_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_verifications_email ON public.email_verifications USING btree (email);

--
-- Name: idx_file_references_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_file_references_company ON public.file_references USING btree (company_id);

--
-- Name: idx_file_references_document; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_file_references_document ON public.file_references USING btree (document_id);

--
-- Name: idx_file_references_module_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_file_references_module_entity ON public.file_references USING btree (linked_module, linked_entity_id);

--
-- Name: idx_folder_access_folder; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_folder_access_folder ON public.folder_access USING btree (folder_id);

--
-- Name: idx_folder_access_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_folder_access_group ON public.folder_access USING btree (group_id);

--
-- Name: idx_folder_access_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_folder_access_user ON public.folder_access USING btree (user_id);

--
-- Name: idx_folders_company_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_folders_company_parent ON public.folders USING btree (company_id, parent_id);

--
-- Name: idx_general_ledger_entries_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_general_ledger_entries_account ON public.general_ledger_entries USING btree (version_id, account_number, account_name);

--
-- Name: idx_general_ledger_entries_amount; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_general_ledger_entries_amount ON public.general_ledger_entries USING btree (version_id, debit, credit);

--
-- Name: idx_general_ledger_entries_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_general_ledger_entries_company ON public.general_ledger_entries USING btree (company_id, created_at DESC);

--
-- Name: idx_general_ledger_entries_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_general_ledger_entries_date ON public.general_ledger_entries USING btree (version_id, transaction_date);

--
-- Name: idx_general_ledger_entries_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_general_ledger_entries_hash ON public.general_ledger_entries USING btree (version_id, source_file_id, transaction_hash) WHERE (transaction_hash IS NOT NULL);

--
-- Name: idx_general_ledger_entries_row_number; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_general_ledger_entries_row_number ON public.general_ledger_entries USING btree (version_id, row_number);

--
-- Name: idx_general_ledger_entries_row_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_general_ledger_entries_row_type ON public.general_ledger_entries USING btree (version_id, row_type);

--
-- Name: idx_general_ledger_entries_section; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_general_ledger_entries_section ON public.general_ledger_entries USING btree (version_id, account_section);

--
-- Name: idx_general_ledger_entries_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_general_ledger_entries_source ON public.general_ledger_entries USING btree (source_file_id);

--
-- Name: idx_general_ledger_entries_version_year; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_general_ledger_entries_version_year ON public.general_ledger_entries USING btree (version_id, fiscal_year);

--
-- Name: idx_gl_entries_coa; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gl_entries_coa ON public.general_ledger_entries USING btree (version_id, coa_id);

--
-- Name: idx_group_messages_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_group_messages_group ON public.group_messages USING btree (group_id, created_at);

--
-- Name: idx_key_report_file_mappings_document; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_key_report_file_mappings_document ON public.key_report_file_mappings USING btree (document_id);

--
-- Name: idx_key_report_file_mappings_version; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_key_report_file_mappings_version ON public.key_report_file_mappings USING btree (version_id, report_category);

--
-- Name: idx_key_report_file_mappings_version_year; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_key_report_file_mappings_version_year ON public.key_report_file_mappings USING btree (version_id, year);

--
-- Name: idx_key_report_sync_logs_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_key_report_sync_logs_company ON public.key_report_sync_logs USING btree (company_id, created_at DESC);

--
-- Name: idx_key_report_sync_logs_version; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_key_report_sync_logs_version ON public.key_report_sync_logs USING btree (version_id, created_at DESC);

--
-- Name: idx_key_report_validation_results_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_key_report_validation_results_company ON public.key_report_validation_results USING btree (company_id, created_at DESC);

--
-- Name: idx_key_report_validation_results_version; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_key_report_validation_results_version ON public.key_report_validation_results USING btree (version_id, year, data_type);

--
-- Name: idx_key_report_versions_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_key_report_versions_company ON public.key_report_versions USING btree (company_id, created_at DESC);

--
-- Name: idx_manual_gl_batches_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_manual_gl_batches_company ON public.manual_gl_batches USING btree (company_id, created_at DESC);

--
-- Name: idx_manual_gl_batches_company_status_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_manual_gl_batches_company_status_created ON public.manual_gl_batches USING btree (company_id, status, created_at DESC);

--
-- Name: idx_manual_gl_batches_source_isolation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_manual_gl_batches_source_isolation ON public.manual_gl_batches USING btree (company_id, source_type, source_switch_version, upload_session_id, created_at DESC);

--
-- Name: idx_manual_gl_bs_batch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_manual_gl_bs_batch ON public.manual_gl_balance_sheet_lines USING btree (batch_id, sheet_type);

--
-- Name: idx_manual_gl_bs_company_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_manual_gl_bs_company_date ON public.manual_gl_balance_sheet_lines USING btree (company_id, as_of_date);

--
-- Name: idx_manual_gl_bs_source_isolation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_manual_gl_bs_source_isolation ON public.manual_gl_balance_sheet_lines USING btree (company_id, source_type, source_switch_version, upload_session_id, staged_at DESC);

--
-- Name: idx_manual_gl_txn_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_manual_gl_txn_account ON public.manual_gl_staged_transactions USING btree (company_id, account_name, account_number);

--
-- Name: idx_manual_gl_txn_batch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_manual_gl_txn_batch ON public.manual_gl_staged_transactions USING btree (batch_id);

--
-- Name: idx_manual_gl_txn_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_manual_gl_txn_category ON public.manual_gl_staged_transactions USING btree (company_id, category, sub_category);

--
-- Name: idx_manual_gl_txn_company_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_manual_gl_txn_company_date ON public.manual_gl_staged_transactions USING btree (company_id, txn_date);

--
-- Name: idx_manual_gl_txn_company_year; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_manual_gl_txn_company_year ON public.manual_gl_staged_transactions USING btree (company_id, fiscal_year);

--
-- Name: idx_manual_gl_txn_source_isolation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_manual_gl_txn_source_isolation ON public.manual_gl_staged_transactions USING btree (company_id, source_type, source_switch_version, upload_session_id, staged_at DESC);

--
-- Name: idx_message_groups_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_message_groups_company ON public.message_groups USING btree (company_id);

--
-- Name: idx_profit_loss_entries_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profit_loss_entries_account ON public.profit_loss_entries USING btree (version_id, account_name, account_number);

--
-- Name: idx_profit_loss_entries_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profit_loss_entries_company ON public.profit_loss_entries USING btree (company_id, created_at DESC);

--
-- Name: idx_profit_loss_entries_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_profit_loss_entries_hash ON public.profit_loss_entries USING btree (version_id, source_file_id, row_hash) WHERE (row_hash IS NOT NULL);

--
-- Name: idx_profit_loss_entries_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profit_loss_entries_source ON public.profit_loss_entries USING btree (source_file_id);

--
-- Name: idx_profit_loss_entries_version_year; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profit_loss_entries_version_year ON public.profit_loss_entries USING btree (version_id, fiscal_year);

--
-- Name: idx_qa_assignees_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_qa_assignees_user ON public.qa_assignees USING btree (user_id) WHERE (removed_at IS NULL);

--
-- Name: idx_qa_assignment_events_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_qa_assignment_events_item ON public.qa_assignment_events USING btree (item_id, at);

--
-- Name: idx_qa_item_visibility_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_qa_item_visibility_item ON public.qa_item_visibility USING btree (item_id);

--
-- Name: idx_qa_items_company_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_qa_items_company_category ON public.qa_items USING btree (company_id, category_id);

--
-- Name: idx_qa_items_company_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_qa_items_company_status ON public.qa_items USING btree (company_id, status);

--
-- Name: idx_qa_items_external_ref; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_qa_items_external_ref ON public.qa_items USING btree (external_ref) WHERE (external_ref IS NOT NULL);

--
-- Name: idx_qa_presentations_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_qa_presentations_item ON public.qa_presentations USING btree (item_id, version);

--
-- Name: idx_qa_responses_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_qa_responses_item ON public.qa_responses USING btree (item_id, posted_at);

--
-- Name: idx_qoe_addbacks_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_qoe_addbacks_scope ON public.qoe_addbacks USING btree (company_id, version_id, deleted_at);

--
-- Name: idx_reconciliation_transactions_client_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reconciliation_transactions_client_id ON public.reconciliation_transactions USING btree (client_id);

--
-- Name: idx_reminders_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reminders_company ON public.reminders USING btree (company_id);

--
-- Name: idx_report_source_records_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_report_source_records_company ON public.report_source_records USING btree (company_id, source_key);

--
-- Name: idx_report_source_records_selected; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_report_source_records_selected ON public.report_source_records USING btree (company_id, is_selected);

--
-- Name: idx_requests_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_requests_company_id ON public.requests USING btree (company_id);

--
-- Name: idx_tax_return_entries_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tax_return_entries_company ON public.tax_return_entries USING btree (company_id, created_at DESC);

--
-- Name: idx_tax_return_entries_field; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tax_return_entries_field ON public.tax_return_entries USING btree (version_id, field_name);

--
-- Name: idx_tax_return_entries_schedule; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tax_return_entries_schedule ON public.tax_return_entries USING btree (version_id, schedule);

--
-- Name: idx_tax_return_entries_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tax_return_entries_source ON public.tax_return_entries USING btree (source_file_id);

--
-- Name: idx_tax_return_entries_version_year; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tax_return_entries_version_year ON public.tax_return_entries USING btree (version_id, tax_year);

--
-- Name: idx_upload_sessions_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_upload_sessions_expiry ON public.upload_sessions USING btree (status, expires_at);

--
-- Name: idx_user_companies_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_companies_company ON public.user_companies USING btree (company_id);

--
-- Name: idx_user_companies_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_companies_user ON public.user_companies USING btree (user_id);

--
-- Name: idx_user_preferences_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_preferences_user ON public.user_preferences USING btree (user_id);

--
-- Name: idx_workspace_page_state_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_page_state_company ON public.workspace_page_state USING btree (company_id, updated_at DESC);

--
-- Name: qa_responses_citation_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX qa_responses_citation_uq ON public.qa_responses USING btree (citation_ref);

--
-- Name: qa_responses_current_root_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX qa_responses_current_root_uq ON public.qa_responses USING btree (answer_root_id) WHERE (is_current AND (kind = 'answer'::text) AND (answer_root_id IS NOT NULL));

--
-- Name: session_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX session_user_id_idx ON public.session USING btree (user_id);

--
-- Name: uq_key_report_versions_company_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_key_report_versions_company_active ON public.key_report_versions USING btree (company_id) WHERE (is_active = true);

--
-- Name: verification_identifier_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX verification_identifier_idx ON public.verification USING btree (identifier);

--
-- Name: account account_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account
    ADD CONSTRAINT account_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.auth_user(id) ON DELETE CASCADE;

--
-- Name: activity_log activity_log_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_log
    ADD CONSTRAINT activity_log_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

--
-- Name: activity_log activity_log_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_log
    ADD CONSTRAINT activity_log_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT;

--
-- Name: balance_sheet_entries balance_sheet_entries_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.balance_sheet_entries
    ADD CONSTRAINT balance_sheet_entries_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

--
-- Name: balance_sheet_entries balance_sheet_entries_source_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.balance_sheet_entries
    ADD CONSTRAINT balance_sheet_entries_source_file_id_fkey FOREIGN KEY (source_file_id) REFERENCES public.documents(id) ON DELETE RESTRICT;

--
-- Name: balance_sheet_entries balance_sheet_entries_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.balance_sheet_entries
    ADD CONSTRAINT balance_sheet_entries_version_id_fkey FOREIGN KEY (version_id) REFERENCES public.key_report_versions(id) ON DELETE CASCADE;

--
-- Name: bank_statement_entries bank_statement_entries_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bank_statement_entries
    ADD CONSTRAINT bank_statement_entries_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

--
-- Name: bank_statement_entries bank_statement_entries_source_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bank_statement_entries
    ADD CONSTRAINT bank_statement_entries_source_file_id_fkey FOREIGN KEY (source_file_id) REFERENCES public.documents(id) ON DELETE RESTRICT;

--
-- Name: bank_statement_entries bank_statement_entries_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bank_statement_entries
    ADD CONSTRAINT bank_statement_entries_version_id_fkey FOREIGN KEY (version_id) REFERENCES public.key_report_versions(id) ON DELETE CASCADE;

--
-- Name: broker_team_invites broker_team_invites_invited_broker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.broker_team_invites
    ADD CONSTRAINT broker_team_invites_invited_broker_id_fkey FOREIGN KEY (invited_broker_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: broker_team_invites broker_team_invites_team_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.broker_team_invites
    ADD CONSTRAINT broker_team_invites_team_owner_id_fkey FOREIGN KEY (team_owner_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: buyer_group_members buyer_group_members_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.buyer_group_members
    ADD CONSTRAINT buyer_group_members_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.buyer_groups(id) ON DELETE CASCADE;

--
-- Name: buyer_group_members buyer_group_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.buyer_group_members
    ADD CONSTRAINT buyer_group_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: buyer_groups buyer_groups_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.buyer_groups
    ADD CONSTRAINT buyer_groups_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

--
-- Name: chart_of_accounts chart_of_accounts_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chart_of_accounts
    ADD CONSTRAINT chart_of_accounts_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

--
-- Name: chart_of_accounts chart_of_accounts_parent_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chart_of_accounts
    ADD CONSTRAINT chart_of_accounts_parent_account_id_fkey FOREIGN KEY (parent_account_id) REFERENCES public.chart_of_accounts(id) ON DELETE SET NULL;

--
-- Name: chart_of_accounts chart_of_accounts_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chart_of_accounts
    ADD CONSTRAINT chart_of_accounts_version_id_fkey FOREIGN KEY (version_id) REFERENCES public.key_report_versions(id) ON DELETE CASCADE;

--
-- Name: cim_block_provenance cim_block_provenance_accepted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cim_block_provenance
    ADD CONSTRAINT cim_block_provenance_accepted_by_fkey FOREIGN KEY (accepted_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: cim_block_provenance cim_block_provenance_block_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cim_block_provenance
    ADD CONSTRAINT cim_block_provenance_block_id_fkey FOREIGN KEY (block_id) REFERENCES public.cim_blocks(id) ON DELETE CASCADE;

--
-- Name: cim_block_provenance cim_block_provenance_respondent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cim_block_provenance
    ADD CONSTRAINT cim_block_provenance_respondent_id_fkey FOREIGN KEY (respondent_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: cim_blocks cim_blocks_slide_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cim_blocks
    ADD CONSTRAINT cim_blocks_slide_id_fkey FOREIGN KEY (slide_id) REFERENCES public.cim_slides(id) ON DELETE CASCADE;

--
-- Name: cim_blocks cim_blocks_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cim_blocks
    ADD CONSTRAINT cim_blocks_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: cim_blocks cim_blocks_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cim_blocks
    ADD CONSTRAINT cim_blocks_version_id_fkey FOREIGN KEY (version_id) REFERENCES public.cim_versions(id) ON DELETE CASCADE;

--
-- Name: cim_decks cim_decks_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cim_decks
    ADD CONSTRAINT cim_decks_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

--
-- Name: cim_decks cim_decks_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cim_decks
    ADD CONSTRAINT cim_decks_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: cim_publications cim_publications_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cim_publications
    ADD CONSTRAINT cim_publications_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE SET NULL;

--
-- Name: cim_publications cim_publications_published_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cim_publications
    ADD CONSTRAINT cim_publications_published_by_fkey FOREIGN KEY (published_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: cim_publications cim_publications_upload_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cim_publications
    ADD CONSTRAINT cim_publications_upload_id_fkey FOREIGN KEY (upload_id) REFERENCES public.uploads(id) ON DELETE SET NULL;

--
-- Name: cim_publications cim_publications_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cim_publications
    ADD CONSTRAINT cim_publications_version_id_fkey FOREIGN KEY (version_id) REFERENCES public.cim_versions(id) ON DELETE CASCADE;

--
-- Name: cim_sections cim_sections_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cim_sections
    ADD CONSTRAINT cim_sections_version_id_fkey FOREIGN KEY (version_id) REFERENCES public.cim_versions(id) ON DELETE CASCADE;

--
-- Name: cim_slides cim_slides_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cim_slides
    ADD CONSTRAINT cim_slides_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.cim_sections(id) ON DELETE CASCADE;

--
-- Name: cim_slides cim_slides_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cim_slides
    ADD CONSTRAINT cim_slides_version_id_fkey FOREIGN KEY (version_id) REFERENCES public.cim_versions(id) ON DELETE CASCADE;

--
-- Name: cim_versions cim_versions_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cim_versions
    ADD CONSTRAINT cim_versions_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: cim_versions cim_versions_deck_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cim_versions
    ADD CONSTRAINT cim_versions_deck_id_fkey FOREIGN KEY (deck_id) REFERENCES public.cim_decks(id) ON DELETE CASCADE;

--
-- Name: cim_versions cim_versions_published_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cim_versions
    ADD CONSTRAINT cim_versions_published_by_fkey FOREIGN KEY (published_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: coa_account_adjustments coa_account_adjustments_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coa_account_adjustments
    ADD CONSTRAINT coa_account_adjustments_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.chart_of_accounts(id) ON DELETE CASCADE;

--
-- Name: coa_account_adjustments coa_account_adjustments_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coa_account_adjustments
    ADD CONSTRAINT coa_account_adjustments_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

--
-- Name: coa_account_adjustments coa_account_adjustments_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coa_account_adjustments
    ADD CONSTRAINT coa_account_adjustments_version_id_fkey FOREIGN KEY (version_id) REFERENCES public.key_report_versions(id) ON DELETE CASCADE;

--
-- Name: coa_account_mappings coa_account_mappings_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coa_account_mappings
    ADD CONSTRAINT coa_account_mappings_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.chart_of_accounts(id) ON DELETE CASCADE;

--
-- Name: coa_account_mappings coa_account_mappings_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coa_account_mappings
    ADD CONSTRAINT coa_account_mappings_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

--
-- Name: coa_account_mappings coa_account_mappings_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coa_account_mappings
    ADD CONSTRAINT coa_account_mappings_version_id_fkey FOREIGN KEY (version_id) REFERENCES public.key_report_versions(id) ON DELETE CASCADE;

--
-- Name: coa_classification_history coa_classification_history_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coa_classification_history
    ADD CONSTRAINT coa_classification_history_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.chart_of_accounts(id) ON DELETE CASCADE;

--
-- Name: coa_classification_history coa_classification_history_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coa_classification_history
    ADD CONSTRAINT coa_classification_history_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

--
-- Name: coa_classification_history coa_classification_history_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coa_classification_history
    ADD CONSTRAINT coa_classification_history_version_id_fkey FOREIGN KEY (version_id) REFERENCES public.key_report_versions(id) ON DELETE CASCADE;

--
-- Name: company_messages company_messages_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_messages
    ADD CONSTRAINT company_messages_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

--
-- Name: company_messages company_messages_sender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_messages
    ADD CONSTRAINT company_messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: direct_messages direct_messages_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.direct_messages
    ADD CONSTRAINT direct_messages_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

--
-- Name: direct_messages direct_messages_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.direct_messages
    ADD CONSTRAINT direct_messages_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: direct_messages direct_messages_sender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.direct_messages
    ADD CONSTRAINT direct_messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: document_activity document_activity_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_activity
    ADD CONSTRAINT document_activity_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;

--
-- Name: document_activity document_activity_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_activity
    ADD CONSTRAINT document_activity_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: document_comments document_comments_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_comments
    ADD CONSTRAINT document_comments_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: document_comments document_comments_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_comments
    ADD CONSTRAINT document_comments_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

--
-- Name: document_comments document_comments_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_comments
    ADD CONSTRAINT document_comments_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;

--
-- Name: document_comments document_comments_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_comments
    ADD CONSTRAINT document_comments_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.document_comments(id) ON DELETE CASCADE;

--
-- Name: document_comments document_comments_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_comments
    ADD CONSTRAINT document_comments_version_id_fkey FOREIGN KEY (version_id) REFERENCES public.document_versions(id) ON DELETE SET NULL;

--
-- Name: document_versions document_versions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: document_versions document_versions_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;

--
-- Name: document_versions document_versions_upload_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_upload_id_fkey FOREIGN KEY (upload_id) REFERENCES public.uploads(id) ON DELETE SET NULL;

--
-- Name: documents documents_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

--
-- Name: documents documents_folder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_folder_id_fkey FOREIGN KEY (folder_id) REFERENCES public.folders(id) ON DELETE CASCADE;

--
-- Name: documents documents_upload_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_upload_id_fkey FOREIGN KEY (upload_id) REFERENCES public.uploads(id) ON DELETE SET NULL;

--
-- Name: documents documents_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE RESTRICT;

--
-- Name: file_references file_references_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_references
    ADD CONSTRAINT file_references_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

--
-- Name: file_references file_references_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_references
    ADD CONSTRAINT file_references_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: file_references file_references_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_references
    ADD CONSTRAINT file_references_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE RESTRICT;

--
-- Name: folder_access folder_access_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.folder_access
    ADD CONSTRAINT folder_access_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT;

--
-- Name: folder_access folder_access_folder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.folder_access
    ADD CONSTRAINT folder_access_folder_id_fkey FOREIGN KEY (folder_id) REFERENCES public.folders(id) ON DELETE CASCADE;

--
-- Name: folder_access folder_access_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.folder_access
    ADD CONSTRAINT folder_access_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.buyer_groups(id) ON DELETE CASCADE;

--
-- Name: folder_access folder_access_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.folder_access
    ADD CONSTRAINT folder_access_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: folders folders_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.folders
    ADD CONSTRAINT folders_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

--
-- Name: folders folders_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.folders
    ADD CONSTRAINT folders_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT;

--
-- Name: folders folders_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.folders
    ADD CONSTRAINT folders_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.folders(id) ON DELETE SET NULL;

--
-- Name: general_ledger_entries general_ledger_entries_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.general_ledger_entries
    ADD CONSTRAINT general_ledger_entries_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

--
-- Name: general_ledger_entries general_ledger_entries_source_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.general_ledger_entries
    ADD CONSTRAINT general_ledger_entries_source_file_id_fkey FOREIGN KEY (source_file_id) REFERENCES public.documents(id) ON DELETE RESTRICT;

--
-- Name: general_ledger_entries general_ledger_entries_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.general_ledger_entries
    ADD CONSTRAINT general_ledger_entries_version_id_fkey FOREIGN KEY (version_id) REFERENCES public.key_report_versions(id) ON DELETE CASCADE;

--
-- Name: group_message_reads group_message_reads_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_message_reads
    ADD CONSTRAINT group_message_reads_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.message_groups(id) ON DELETE CASCADE;

--
-- Name: group_messages group_messages_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_messages
    ADD CONSTRAINT group_messages_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.message_groups(id) ON DELETE CASCADE;

--
-- Name: key_report_coa_hierarchy_recommendations key_report_coa_hierarchy_recommendations_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.key_report_coa_hierarchy_recommendations
    ADD CONSTRAINT key_report_coa_hierarchy_recommendations_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.chart_of_accounts(id) ON DELETE CASCADE;

--
-- Name: key_report_coa_hierarchy_recommendations key_report_coa_hierarchy_recommendations_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.key_report_coa_hierarchy_recommendations
    ADD CONSTRAINT key_report_coa_hierarchy_recommendations_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

--
-- Name: key_report_coa_hierarchy_recommendations key_report_coa_hierarchy_recommendations_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.key_report_coa_hierarchy_recommendations
    ADD CONSTRAINT key_report_coa_hierarchy_recommendations_version_id_fkey FOREIGN KEY (version_id) REFERENCES public.key_report_versions(id) ON DELETE CASCADE;

--
-- Name: key_report_file_mappings key_report_file_mappings_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.key_report_file_mappings
    ADD CONSTRAINT key_report_file_mappings_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

--
-- Name: key_report_file_mappings key_report_file_mappings_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.key_report_file_mappings
    ADD CONSTRAINT key_report_file_mappings_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE SET NULL;

--
-- Name: key_report_file_mappings key_report_file_mappings_linked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.key_report_file_mappings
    ADD CONSTRAINT key_report_file_mappings_linked_by_fkey FOREIGN KEY (linked_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: key_report_file_mappings key_report_file_mappings_upload_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.key_report_file_mappings
    ADD CONSTRAINT key_report_file_mappings_upload_id_fkey FOREIGN KEY (upload_id) REFERENCES public.uploads(id) ON DELETE SET NULL;

--
-- Name: key_report_file_mappings key_report_file_mappings_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.key_report_file_mappings
    ADD CONSTRAINT key_report_file_mappings_version_id_fkey FOREIGN KEY (version_id) REFERENCES public.key_report_versions(id) ON DELETE CASCADE;

--
-- Name: key_report_sync_logs key_report_sync_logs_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.key_report_sync_logs
    ADD CONSTRAINT key_report_sync_logs_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

--
-- Name: key_report_sync_logs key_report_sync_logs_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.key_report_sync_logs
    ADD CONSTRAINT key_report_sync_logs_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: key_report_sync_logs key_report_sync_logs_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.key_report_sync_logs
    ADD CONSTRAINT key_report_sync_logs_version_id_fkey FOREIGN KEY (version_id) REFERENCES public.key_report_versions(id) ON DELETE CASCADE;

--
-- Name: key_report_validation_results key_report_validation_results_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.key_report_validation_results
    ADD CONSTRAINT key_report_validation_results_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

--
-- Name: key_report_validation_results key_report_validation_results_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.key_report_validation_results
    ADD CONSTRAINT key_report_validation_results_version_id_fkey FOREIGN KEY (version_id) REFERENCES public.key_report_versions(id) ON DELETE CASCADE;

--
-- Name: key_report_versions key_report_versions_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.key_report_versions
    ADD CONSTRAINT key_report_versions_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

--
-- Name: key_report_versions key_report_versions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.key_report_versions
    ADD CONSTRAINT key_report_versions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: key_report_versions key_report_versions_resolved_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.key_report_versions
    ADD CONSTRAINT key_report_versions_resolved_batch_id_fkey FOREIGN KEY (resolved_batch_id) REFERENCES public.manual_gl_batches(id) ON DELETE SET NULL;

--
-- Name: key_report_versions key_report_versions_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.key_report_versions
    ADD CONSTRAINT key_report_versions_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: manual_gl_balance_sheet_lines manual_gl_balance_sheet_lines_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manual_gl_balance_sheet_lines
    ADD CONSTRAINT manual_gl_balance_sheet_lines_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.manual_gl_batches(id) ON DELETE CASCADE;

--
-- Name: manual_gl_balance_sheet_lines manual_gl_balance_sheet_lines_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manual_gl_balance_sheet_lines
    ADD CONSTRAINT manual_gl_balance_sheet_lines_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

--
-- Name: manual_gl_balance_sheet_lines manual_gl_balance_sheet_lines_source_upload_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manual_gl_balance_sheet_lines
    ADD CONSTRAINT manual_gl_balance_sheet_lines_source_upload_id_fkey FOREIGN KEY (source_upload_id) REFERENCES public.uploads(id) ON DELETE SET NULL;

--
-- Name: manual_gl_batches manual_gl_batches_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manual_gl_batches
    ADD CONSTRAINT manual_gl_batches_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

--
-- Name: manual_gl_batches manual_gl_batches_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manual_gl_batches
    ADD CONSTRAINT manual_gl_batches_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: manual_gl_staged_transactions manual_gl_staged_transactions_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manual_gl_staged_transactions
    ADD CONSTRAINT manual_gl_staged_transactions_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.manual_gl_batches(id) ON DELETE CASCADE;

--
-- Name: manual_gl_staged_transactions manual_gl_staged_transactions_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manual_gl_staged_transactions
    ADD CONSTRAINT manual_gl_staged_transactions_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

--
-- Name: manual_gl_staged_transactions manual_gl_staged_transactions_source_upload_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manual_gl_staged_transactions
    ADD CONSTRAINT manual_gl_staged_transactions_source_upload_id_fkey FOREIGN KEY (source_upload_id) REFERENCES public.uploads(id) ON DELETE SET NULL;

--
-- Name: message_group_members message_group_members_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_group_members
    ADD CONSTRAINT message_group_members_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.message_groups(id) ON DELETE CASCADE;

--
-- Name: message_groups message_groups_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_groups
    ADD CONSTRAINT message_groups_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

--
-- Name: profit_loss_entries profit_loss_entries_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profit_loss_entries
    ADD CONSTRAINT profit_loss_entries_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

--
-- Name: profit_loss_entries profit_loss_entries_source_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profit_loss_entries
    ADD CONSTRAINT profit_loss_entries_source_file_id_fkey FOREIGN KEY (source_file_id) REFERENCES public.documents(id) ON DELETE RESTRICT;

--
-- Name: profit_loss_entries profit_loss_entries_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profit_loss_entries
    ADD CONSTRAINT profit_loss_entries_version_id_fkey FOREIGN KEY (version_id) REFERENCES public.key_report_versions(id) ON DELETE CASCADE;

--
-- Name: qa_assignees qa_assignees_assigned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_assignees
    ADD CONSTRAINT qa_assignees_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: qa_assignees qa_assignees_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_assignees
    ADD CONSTRAINT qa_assignees_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.qa_items(id) ON DELETE CASCADE;

--
-- Name: qa_assignees qa_assignees_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_assignees
    ADD CONSTRAINT qa_assignees_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: qa_assignment_events qa_assignment_events_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_assignment_events
    ADD CONSTRAINT qa_assignment_events_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: qa_assignment_events qa_assignment_events_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_assignment_events
    ADD CONSTRAINT qa_assignment_events_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.qa_items(id) ON DELETE CASCADE;

--
-- Name: qa_attachments qa_attachments_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_attachments
    ADD CONSTRAINT qa_attachments_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: qa_attachments qa_attachments_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_attachments
    ADD CONSTRAINT qa_attachments_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;

--
-- Name: qa_attachments qa_attachments_folder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_attachments
    ADD CONSTRAINT qa_attachments_folder_id_fkey FOREIGN KEY (folder_id) REFERENCES public.folders(id) ON DELETE SET NULL;

--
-- Name: qa_attachments qa_attachments_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_attachments
    ADD CONSTRAINT qa_attachments_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.qa_items(id) ON DELETE CASCADE;

--
-- Name: qa_attachments qa_attachments_response_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_attachments
    ADD CONSTRAINT qa_attachments_response_id_fkey FOREIGN KEY (response_id) REFERENCES public.qa_responses(id) ON DELETE CASCADE;

--
-- Name: qa_categories qa_categories_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_categories
    ADD CONSTRAINT qa_categories_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

--
-- Name: qa_item_visibility qa_item_visibility_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_item_visibility
    ADD CONSTRAINT qa_item_visibility_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: qa_item_visibility qa_item_visibility_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_item_visibility
    ADD CONSTRAINT qa_item_visibility_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.qa_items(id) ON DELETE CASCADE;

--
-- Name: qa_item_visibility qa_item_visibility_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_item_visibility
    ADD CONSTRAINT qa_item_visibility_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: qa_items qa_items_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_items
    ADD CONSTRAINT qa_items_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.qa_categories(id) ON DELETE SET NULL;

--
-- Name: qa_items qa_items_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_items
    ADD CONSTRAINT qa_items_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

--
-- Name: qa_items qa_items_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_items
    ADD CONSTRAINT qa_items_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: qa_items qa_items_requestor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_items
    ADD CONSTRAINT qa_items_requestor_id_fkey FOREIGN KEY (requestor_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: qa_nominations qa_nominations_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_nominations
    ADD CONSTRAINT qa_nominations_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.qa_categories(id) ON DELETE CASCADE;

--
-- Name: qa_nominations qa_nominations_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_nominations
    ADD CONSTRAINT qa_nominations_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

--
-- Name: qa_nominations qa_nominations_nominated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_nominations
    ADD CONSTRAINT qa_nominations_nominated_by_fkey FOREIGN KEY (nominated_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: qa_nominations qa_nominations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_nominations
    ADD CONSTRAINT qa_nominations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: qa_presentations qa_presentations_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_presentations
    ADD CONSTRAINT qa_presentations_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: qa_presentations qa_presentations_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_presentations
    ADD CONSTRAINT qa_presentations_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.qa_items(id) ON DELETE CASCADE;

--
-- Name: qa_presentations qa_presentations_source_response_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_presentations
    ADD CONSTRAINT qa_presentations_source_response_id_fkey FOREIGN KEY (source_response_id) REFERENCES public.qa_responses(id) ON DELETE CASCADE;

--
-- Name: qa_responses qa_responses_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_responses
    ADD CONSTRAINT qa_responses_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: qa_responses qa_responses_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_responses
    ADD CONSTRAINT qa_responses_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.qa_items(id) ON DELETE CASCADE;

--
-- Name: qa_responses qa_responses_supersedes_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_responses
    ADD CONSTRAINT qa_responses_supersedes_id_fkey FOREIGN KEY (supersedes_id) REFERENCES public.qa_responses(id) ON DELETE SET NULL;

--
-- Name: qoe_addbacks qoe_addbacks_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qoe_addbacks
    ADD CONSTRAINT qoe_addbacks_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

--
-- Name: qoe_addbacks qoe_addbacks_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qoe_addbacks
    ADD CONSTRAINT qoe_addbacks_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: reminders reminders_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reminders
    ADD CONSTRAINT reminders_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

--
-- Name: reminders reminders_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reminders
    ADD CONSTRAINT reminders_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT;

--
-- Name: reminders reminders_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reminders
    ADD CONSTRAINT reminders_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.requests(id) ON DELETE CASCADE;

--
-- Name: report_source_records report_source_records_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_source_records
    ADD CONSTRAINT report_source_records_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

--
-- Name: request_documents request_documents_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_documents
    ADD CONSTRAINT request_documents_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;

--
-- Name: request_documents request_documents_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_documents
    ADD CONSTRAINT request_documents_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.requests(id) ON DELETE CASCADE;

--
-- Name: request_narratives request_narratives_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_narratives
    ADD CONSTRAINT request_narratives_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.requests(id) ON DELETE CASCADE;

--
-- Name: request_narratives request_narratives_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_narratives
    ADD CONSTRAINT request_narratives_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE RESTRICT;

--
-- Name: request_reminders request_reminders_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_reminders
    ADD CONSTRAINT request_reminders_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.requests(id) ON DELETE CASCADE;

--
-- Name: request_reminders request_reminders_sent_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_reminders
    ADD CONSTRAINT request_reminders_sent_by_fkey FOREIGN KEY (sent_by) REFERENCES public.users(id) ON DELETE RESTRICT;

--
-- Name: requests requests_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.requests
    ADD CONSTRAINT requests_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: requests requests_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.requests
    ADD CONSTRAINT requests_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: requests requests_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.requests
    ADD CONSTRAINT requests_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

--
-- Name: requests requests_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.requests
    ADD CONSTRAINT requests_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT;

--
-- Name: session session_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.auth_user(id) ON DELETE CASCADE;

--
-- Name: tax_return_entries tax_return_entries_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_return_entries
    ADD CONSTRAINT tax_return_entries_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

--
-- Name: tax_return_entries tax_return_entries_source_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_return_entries
    ADD CONSTRAINT tax_return_entries_source_file_id_fkey FOREIGN KEY (source_file_id) REFERENCES public.documents(id) ON DELETE RESTRICT;

--
-- Name: tax_return_entries tax_return_entries_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_return_entries
    ADD CONSTRAINT tax_return_entries_version_id_fkey FOREIGN KEY (version_id) REFERENCES public.key_report_versions(id) ON DELETE CASCADE;

--
-- Name: upload_chunks upload_chunks_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_chunks
    ADD CONSTRAINT upload_chunks_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.upload_sessions(id) ON DELETE CASCADE;

--
-- Name: upload_sessions upload_sessions_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_sessions
    ADD CONSTRAINT upload_sessions_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

--
-- Name: upload_sessions upload_sessions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_sessions
    ADD CONSTRAINT upload_sessions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: upload_sessions upload_sessions_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_sessions
    ADD CONSTRAINT upload_sessions_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;

--
-- Name: upload_sessions upload_sessions_folder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_sessions
    ADD CONSTRAINT upload_sessions_folder_id_fkey FOREIGN KEY (folder_id) REFERENCES public.folders(id) ON DELETE CASCADE;

--
-- Name: upload_sessions upload_sessions_upload_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_sessions
    ADD CONSTRAINT upload_sessions_upload_id_fkey FOREIGN KEY (upload_id) REFERENCES public.uploads(id) ON DELETE SET NULL;

--
-- Name: uploads uploads_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.uploads
    ADD CONSTRAINT uploads_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: user_companies user_companies_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_companies
    ADD CONSTRAINT user_companies_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

--
-- Name: user_companies user_companies_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_companies
    ADD CONSTRAINT user_companies_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: user_preferences user_preferences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_preferences
    ADD CONSTRAINT user_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: users users_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE SET NULL;

--
-- Name: workspace_page_state workspace_page_state_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_page_state
    ADD CONSTRAINT workspace_page_state_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

--
-- PostgreSQL database dump complete
--

