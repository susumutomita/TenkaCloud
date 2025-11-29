import { create } from "zustand";

export type Step = "profile" | "plan" | "tenant" | "environment" | "review";

export type PlanTier = "free" | "pro" | "enterprise";

export type TenantModel = "pool" | "silo";

export type ComputeType = "serverless" | "kubernetes";

export interface ProfileData {
  fullName: string;
  email: string;
  organizationName: string;
  purpose: string;
}

export interface PlanData {
  tier: PlanTier;
}

export interface TenantData {
  name: string;
  slug: string;
  region: string;
}

export interface EnvironmentData {
  model: TenantModel;
  compute: ComputeType;
}

export interface OnboardingState {
  currentStep: Step;
  profileData: Partial<ProfileData>;
  planData: Partial<PlanData>;
  tenantData: Partial<TenantData>;
  environmentData: Partial<EnvironmentData>;

  setCurrentStep: (step: Step) => void;
  setProfileData: (data: Partial<ProfileData>) => void;
  setPlanData: (data: Partial<PlanData>) => void;
  setTenantData: (data: Partial<TenantData>) => void;
  setEnvironmentData: (data: Partial<EnvironmentData>) => void;
  reset: () => void;
}

const initialState = {
  currentStep: "profile" as Step,
  profileData: {},
  planData: {},
  tenantData: {},
  environmentData: {},
};

export const useOnboardingStore = create<OnboardingState>((set) => ({
  ...initialState,

  setCurrentStep: (step) => set({ currentStep: step }),

  setProfileData: (data) =>
    set((state) => ({
      profileData: { ...state.profileData, ...data },
    })),

  setPlanData: (data) =>
    set((state) => ({
      planData: { ...state.planData, ...data },
    })),

  setTenantData: (data) =>
    set((state) => ({
      tenantData: { ...state.tenantData, ...data },
    })),

  setEnvironmentData: (data) =>
    set((state) => ({
      environmentData: { ...state.environmentData, ...data },
    })),

  reset: () => set(initialState),
}));
