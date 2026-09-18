import { redirect } from "next/navigation";

export default async function BrandHome({ params }: { params: Promise<{ brandId: string }> }) {
  const { brandId } = await params;
  redirect(`/brands/${brandId}/calendar`);
}
