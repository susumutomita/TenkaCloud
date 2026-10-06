import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { fireEvent, within } from "@testing-library/react";

export function problemPicker(container: HTMLElement) {
  const wrapper = createWrapper(container);
  const options = () => wrapper.findAllCheckboxes('[data-testid^="problem-checkbox-"]');
  return {
    toggleProblem(value: string) {
      const input = within(
        within(container).getByTestId(`problem-checkbox-${value}`),
      ).getByRole<HTMLInputElement>("checkbox");
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
