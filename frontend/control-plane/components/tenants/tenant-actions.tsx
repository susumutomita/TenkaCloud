"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { tenantApi } from "@/lib/api/tenant-api";

interface TenantActionsProps {
  tenantId: string;
}

export function TenantActions({ tenantId }: TenantActionsProps) {
  const router = useRouter();
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDelete = async () => {
    if (
      !confirm("本当にこのテナントを削除しますか？この操作は取り消せません。")
    ) {
      return;
    }

    setIsDeleting(true);
    try {
      await tenantApi.deleteTenant(tenantId);
      router.push("/dashboard/tenants");
      router.refresh();
    } catch (error) {
      console.error("Failed to delete tenant:", error);
      alert("テナント削除に失敗しました");
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleDelete}
      disabled={isDeleting}
      className="inline-flex items-center justify-center rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500 disabled:pointer-events-none disabled:opacity-50"
    >
      {isDeleting ? "削除中..." : "削除"}
    </button>
  );
}
