import type { Metadata } from "next";
import {
  PageContainer,
  PageHeader,
  PageTitle,
  PageDescription,
} from "@/components/layout/page-layout";

export const metadata: Metadata = { title: "Digital Assets" };

/**
 * Route placeholder for the application shell (ATL-005).
 *
 * The shell needs every primary destination to resolve so navigation, focus
 * order, and accessibility can be verified. This surface is built by **ATL-031**;
 * it renders no data and contains no business logic.
 */
export default function AssetsPage() {
  return (
    <PageContainer>
      <PageHeader>
        <PageTitle>Digital Assets</PageTitle>
        <PageDescription>Services and accounts connected to you.</PageDescription>
      </PageHeader>
    </PageContainer>
  );
}
