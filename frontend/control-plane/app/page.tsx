import { redirect } from "next/navigation";
import { auth } from "@/auth";

export default async function HomePage() {
  const session = await auth();

  // 認証済みユーザーはダッシュボードへ、未認証ユーザーはログインページへ
  if (session?.user) {
    redirect("/dashboard");
  }

  redirect("/login");
}
