import { TopicPage, topicMetadata } from "@/components/topic-page";
import { topicBySlug } from "@/lib/topics";

export const dynamic = "force-static";

const topic = topicBySlug("plan-your-day-with-ai");

export const metadata = topicMetadata(topic);

export default function Page() {
  return <TopicPage topic={topic} />;
}
