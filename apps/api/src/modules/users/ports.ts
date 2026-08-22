import type { AssignedCompany, SubRole, UserRole, UserStatus } from "@datahub/contracts";

/** A user row as the module works with it (camelCase; hash never leaves the module). */
export interface UserRecord {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  passwordHash: string;
  role: UserRole;
  subRole: SubRole | null;
  designation: string | null;
  buyerCompanyName: string | null;
  parentUserId: string | null;
  companyId: string | null;
  status: UserStatus;
  dateOfBirth: string | null;
  occupation: string | null;
  address: string | null;
  brokerCompany: string | null;
  /** Row creation time, surfaced as `created_at`. Null when the row predates it. */
  createdAt: string | null;
}

/** Fields written on create (validated + normalized; hash already computed). */
export interface UserCreateInput {
  name: string;
  email: string;
  phone: string | null;
  passwordHash: string;
  role: UserRole;
  subRole: SubRole | null;
  designation: string | null;
  buyerCompanyName: string | null;
  parentUserId: string | null;
  companyId: string | null;
  status: UserStatus;
}

export type UserUpdatePatch = Partial<Omit<UserCreateInput, "passwordHash">> & {
  passwordHash?: string;
};

/** A broker/admin candidate to inherit a deleted user's records. */
export interface ReplacementCandidate {
  id: string;
  role: UserRole;
}

export interface UsersRepository {
  getById(id: string): Promise<UserRecord | null>;
  getByEmail(email: string): Promise<UserRecord | null>;
  listAll(): Promise<UserRecord[]>;
  create(input: UserCreateInput): Promise<UserRecord>;
  update(id: string, patch: UserUpdatePatch): Promise<UserRecord | null>;

  /** Assigned companies per user (user_companies ∪ primary company_id). */
  assignedCompaniesFor(userIds: readonly string[]): Promise<Map<string, AssignedCompany[]>>;

  addCompanies(userId: string, companyIds: readonly string[]): Promise<void>;
  removeCompanies(userId: string, companyIds: readonly string[]): Promise<void>;

  // Broker-team invites.
  inviteBrokerToTeam(ownerId: string, invitedId: string): Promise<void>;
  removeBrokerFromTeam(ownerId: string, invitedId: string): Promise<void>;
  invitedBrokerIds(ownerId: string): Promise<string[]>;

  /** Broker/admin candidates (≠ excludeId) to inherit records; company-scoped first. */
  replacementCandidates(excludeId: string, companyIds: readonly string[]): Promise<ReplacementCandidate[]>;

  /**
   * Reassign the user's `created_by`/`uploaded_by` records to `replacementId`,
   * remove their company links, and delete the user — atomically (design D4).
   */
  reassignAndDelete(userId: string, replacementId: string): Promise<void>;
}

/** Welcome email on create (best-effort, non-fatal). */
export interface EmailerPort {
  sendWelcome(user: { id: string; email: string; name: string }): Promise<void>;
}

/** In-app notification on create (best-effort, non-fatal). */
export interface NotificationPort {
  notifyUserCreated(newUserId: string, actorId: string): Promise<void>;
}

/** Invalidate the auth module's cached session data for a user on update. */
export interface AuthCachePort {
  invalidate(userId: string): void;
}
