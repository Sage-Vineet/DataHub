import { z } from "zod";

/** Roles as stored by the legacy `user_role` enum. */
export const userRole = z.enum(["admin", "broker", "buyer"]);
export type UserRole = z.infer<typeof userRole>;

export const userStatus = z.enum(["active", "inactive"]);
export type UserStatus = z.infer<typeof userStatus>;

const email = z.string().trim().toLowerCase().email("A valid email address is required.");

/**
 * Password policy, matching the legacy `validatePasswordStrength`:
 * at least 8 characters, at least one letter and one digit.
 */
export const password = z
  .string()
  .min(8, "Password must be at least 8 characters.")
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), {
    message: "Password must include at least one letter and one number.",
  });

const otpCode = z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code.");

export const loginRequest = z.object({
  email,
  password: z.string().min(1, "Password is required."),
});
export type LoginRequest = z.infer<typeof loginRequest>;

export const forgotPasswordRequest = z.object({ email });
export type ForgotPasswordRequest = z.infer<typeof forgotPasswordRequest>;

export const resetPasswordRequest = z.object({
  email,
  otp: otpCode,
  new_password: password,
});
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequest>;

export const otpSendRequest = z.object({ email });
export type OtpSendRequest = z.infer<typeof otpSendRequest>;

export const otpVerifyRequest = z.object({ email, otp: otpCode });
export type OtpVerifyRequest = z.infer<typeof otpVerifyRequest>;

/**
 * Broker self-registration.
 *
 * `verification_token` is the grant issued by `/auth/verify-verification-otp`:
 * signup is the second half of a two-request flow, and without it anyone could
 * register any address. `confirmPassword` is accepted under either spelling
 * because the SPA has sent both.
 */
export const brokerSignupRequest = z
  .object({
    name: z.string().trim().min(1, "Full name is required."),
    email,
    password,
    phone: z.string().trim().min(1, "Please enter a valid phone number."),
    broker_company: z.string().trim().optional(),
    brokerCompany: z.string().trim().optional(),
    confirm_password: z.string().optional(),
    confirmPassword: z.string().optional(),
    verification_token: z.string().trim().min(1, "Email verification required."),
  })
  .refine(
    (v) => {
      const confirm = v.confirm_password ?? v.confirmPassword;
      return confirm === undefined || confirm === v.password;
    },
    { message: "Passwords do not match.", path: ["confirmPassword"] },
  );
export type BrokerSignupRequest = z.infer<typeof brokerSignupRequest>;

/** The user shape returned to clients (never includes password_hash). */
export const sessionUser = z.object({
  id: z.string().uuid(),
  name: z.string(),
  email: z.string().email(),
  role: userRole,
  company_id: z.string().uuid().nullable(),
  status: userStatus,
  company_ids: z.array(z.string().uuid()).optional(),
});
export type SessionUser = z.infer<typeof sessionUser>;

export const loginResponse = z.object({ token: z.string(), user: sessionUser });
export type LoginResponse = z.infer<typeof loginResponse>;
