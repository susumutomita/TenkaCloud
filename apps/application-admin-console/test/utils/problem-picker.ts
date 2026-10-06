import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { fireEvent } from "@testing-library/react";

export function problemPicker(container: HTMLElement) {
  const wrapper = createWrapper(container);
  const options = () => wrapper.findAllCheckboxes('[data-testid^="problem-checkbox-"]');
  return {
    toggleProblem(value: string) {
      const option = wrapper.findCheckbox(`[data-testid="problem-checkbox-${value}"]`);
      if (!option) throw new Error(`Problem checkbox not found: ${value}`);
      const input = option.findNativeInput().getElement();
      if (!input.disabled) fireEvent.click(input);
    },
    findOptions: () =>
      options().map((option) => ({
        getElement: () => option.getElement(),
        findLabel: () => option.find('[data-testid^="problem-title-"]'),
        isDisabled: () => option.findNativeInput().getElement().disabled,
      })),
    findOptionByValue: (value: string) =>
      wrapper.findCheckbox(`[data-testid="problem-checkbox-${value}"]`),
    findTokens: () =>
      wrapper.findTokenGroup('[data-testid="problem-selection"]')?.findTokens() ?? [],
  };
}
