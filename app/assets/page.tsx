import { AssetsWorkbench } from "@/components/assets-workbench";
import { PageHeader } from "@/components/page-header";

export default function AssetsPage() {
  return <><PageHeader eyebrow="Workspace library" title="Assets" description="Upload and manage the real inputs and outputs used by the pre-training pipeline." tabs={["All assets", "Videos", "Pose data", "Robot motion"]} /><AssetsWorkbench /></>;
}
