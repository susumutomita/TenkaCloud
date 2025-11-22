/**
 * Tenant API client
 * TODO: Implement actual API calls to backend
 */

export const tenantApi = {
  /**
   * Delete a tenant by ID
   * @param tenantId - The ID of the tenant to delete
   */
  deleteTenant: async (tenantId: string): Promise<void> => {
    // TODO: Implement actual API call
    console.log('deleteTenant called with ID:', tenantId);
    // Simulate API delay
    await new Promise((resolve) => setTimeout(resolve, 1000));
    throw new Error('Not implemented: Backend API not yet connected');
  },
};
