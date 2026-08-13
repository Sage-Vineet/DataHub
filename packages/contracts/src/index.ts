export * as auth from "./auth.js";
export type {
  UserRole,
  UserStatus,
  LoginRequest,
  ForgotPasswordRequest,
  ResetPasswordRequest,
  OtpSendRequest,
  OtpVerifyRequest,
  SessionUser,
  LoginResponse,
} from "./auth.js";

export * as companies from "./companies.js";
export { normalizeProfitMetric } from "./companies.js";
export type {
  CompanyStatus,
  ProfitMetric,
  CompanyCreate,
  CompanyUpdate,
  CompanyListQuery,
  CompanyResponse,
} from "./companies.js";

export * as users from "./users.js";
export {
  BROKER_SUB_ROLES,
  BROKER_TEAM_SUB_ROLES,
  CLIENT_SIDE_SUB_ROLES,
  CLIENT_TEAM_SUB_ROLES,
} from "./users.js";
export type {
  SubRole,
  EffectiveRole,
  UserCreate,
  UserUpdate,
  UserListQuery,
  CompanyMembership,
  BrokerTeamInvite,
  AssignedCompany,
  UserResponse,
} from "./users.js";

export * as folders from "./folders.js";
export type {
  FolderCreate,
  FolderUpdate,
  FolderMove,
  FolderResponse,
  FolderTreeNode,
  FolderAccessCreate,
  FolderAccessUpdate,
  FolderAccessResponse,
  FolderListQuery,
} from "./folders.js";

export * as uploads from "./uploads.js";
export type {
  DocumentStatus,
  DocumentCreate,
  DocumentListQuery,
  UploadResponse,
  DocumentResponse,
  DocumentActivityCreate,
  DocumentActivityResponse,
} from "./uploads.js";

export * as requests from "./requests.js";
export { resolveReminderFrequencyDays } from "./requests.js";
export type {
  RequestPriority,
  RequestCreate,
  RequestUpdate,
  RequestBulkCreate,
  RequestApprove,
  NarrativeUpdate,
  RequestDocumentLink,
  RequestListQuery,
  RequestResponse,
  ReminderResponse,
} from "./requests.js";
