import { HONEY_TOKEN_MAP } from "@app/helpers/honeyTokens";
import { HoneyTokenType } from "@app/hooks/api/honeyTokens/enums";

type Props = {
  onSelect: (type: HoneyTokenType) => void;
};

const HONEY_TOKEN_OPTIONS = Object.values(HoneyTokenType);

export const HoneyTokenSelect = ({ onSelect }: Props) => {
  return (
    <div className="max-h-[60vh] overflow-y-auto">
      <div className="grid grid-cols-3 gap-2">
        {HONEY_TOKEN_OPTIONS.map((type) => {
          const { image, name, size } = HONEY_TOKEN_MAP[type];

          return (
            <button
              type="button"
              key={type}
              onClick={() => onSelect(type)}
              className="group relative flex h-28 cursor-pointer flex-col items-center justify-center rounded-md border border-mineshaft-600 bg-mineshaft-700 p-4 duration-200 hover:bg-mineshaft-600"
            >
              <img
                src={`/images/integrations/${image}`}
                width={size}
                className="mt-auto"
                alt={`${name} logo`}
              />
              <div className="mt-auto max-w-xs text-center text-xs font-medium text-gray-300 duration-200 group-hover:text-gray-200">
                {name}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
};
