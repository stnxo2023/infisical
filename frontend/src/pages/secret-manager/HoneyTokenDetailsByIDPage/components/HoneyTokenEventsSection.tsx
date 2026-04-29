import { useState } from "react";
import { format, formatDistanceToNow } from "date-fns";
import { ActivityIcon } from "lucide-react";

import {
  Badge,
  Empty,
  EmptyHeader,
  EmptyTitle,
  PageLoader,
  Pagination,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@app/components/v3";
import { useGetHoneyTokenEvents } from "@app/hooks/api/honeyTokens/queries";

type Props = {
  honeyTokenId: string;
  projectId: string;
};

const DEFAULT_PER_PAGE = 25;

export const HoneyTokenEventsSection = ({ honeyTokenId, projectId }: Props) => {
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(DEFAULT_PER_PAGE);

  const { data, isPending } = useGetHoneyTokenEvents({
    honeyTokenId,
    projectId,
    offset: (page - 1) * perPage,
    limit: perPage
  });

  const events = data?.events;
  const totalCount = data?.totalCount ?? 0;

  return (
    <div className="rounded-lg border border-mineshaft-600 bg-mineshaft-900 p-6">
      <div className="mb-4 flex items-center gap-2">
        <ActivityIcon size={16} className="text-bunker-300" />
        <p className="text-sm font-medium text-white">Events</p>
        {totalCount > 0 && (
          <span className="rounded-full bg-mineshaft-600 px-2 py-0.5 text-xs text-bunker-300">
            {totalCount}
          </span>
        )}
      </div>

      {isPending && <PageLoader />}

      {!isPending && (!events || events.length === 0) && (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No events recorded yet</EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}

      {events && events.length > 0 && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-mineshaft-600 text-xs text-bunker-300 uppercase">
                  <th className="px-3 py-2">Timestamp</th>
                  <th className="px-3 py-2">Action</th>
                  <th className="px-3 py-2">Region</th>
                  <th className="px-3 py-2">IP address</th>
                  <th className="px-3 py-2">User agent</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => {
                  const meta = event.metadata;
                  const eventDate = meta?.eventTime
                    ? new Date(meta.eventTime)
                    : new Date(event.createdAt);

                  return (
                    <tr
                      key={event.id}
                      className="border-b border-mineshaft-700 text-sm text-white last:border-0"
                    >
                      <td className="px-3 py-3 whitespace-nowrap text-bunker-300">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span>{formatDistanceToNow(eventDate, { addSuffix: true })}</span>
                          </TooltipTrigger>
                          <TooltipContent>
                            {format(eventDate, "MMMM do, yyyy 'at' h:mm:ss a")}
                          </TooltipContent>
                        </Tooltip>
                      </td>
                      <td className="px-3 py-3">
                        {meta?.eventName ? <Badge variant="neutral">{meta.eventName}</Badge> : "—"}
                      </td>
                      <td className="px-3 py-3 whitespace-nowrap text-bunker-300">
                        {meta?.awsRegion ?? "—"}
                      </td>
                      <td className="px-3 py-3 text-bunker-300">{meta?.sourceIp ?? "—"}</td>
                      <td className="max-w-[300px] px-3 py-3 text-bunker-300">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="block truncate">{meta?.userAgent ?? "—"}</span>
                          </TooltipTrigger>
                          <TooltipContent>{meta?.userAgent}</TooltipContent>
                        </Tooltip>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {totalCount > DEFAULT_PER_PAGE && (
            <Pagination
              count={totalCount}
              page={page}
              perPage={perPage}
              onChangePage={setPage}
              onChangePerPage={(newPerPage) => {
                const totalPages = Math.ceil(totalCount / newPerPage);
                if (page > totalPages) setPage(totalPages);
                setPerPage(newPerPage);
              }}
              perPageList={[25, 50, 100]}
            />
          )}
        </>
      )}
    </div>
  );
};
