-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "TenantTier" AS ENUM ('FREE', 'PRO', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "IsolationModel" AS ENUM ('POOL', 'SILO');

-- CreateEnum
CREATE TYPE "ComputeType" AS ENUM ('KUBERNETES', 'SERVERLESS');

-- CreateEnum
CREATE TYPE "ProvisioningStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
    "tier" "TenantTier" NOT NULL DEFAULT 'FREE',
    "adminEmail" TEXT NOT NULL,
    "region" TEXT NOT NULL DEFAULT 'ap-northeast-1',
    "isolationModel" "IsolationModel" NOT NULL DEFAULT 'POOL',
    "computeType" "ComputeType" NOT NULL DEFAULT 'SERVERLESS',
    "provisioningStatus" "ProvisioningStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_adminEmail_key" ON "tenants"("adminEmail");

-- CreateIndex
CREATE INDEX "tenants_status_idx" ON "tenants"("status");

-- CreateIndex
CREATE INDEX "tenants_adminEmail_idx" ON "tenants"("adminEmail");

-- CreateIndex
CREATE INDEX "tenants_slug_idx" ON "tenants"("slug");
