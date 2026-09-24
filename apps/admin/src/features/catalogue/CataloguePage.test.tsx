import type { AdminCatalogue } from '@tezusta/types';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { adminMe, apiError, installFakeServer } from '../../../test/fake-server';
import { renderApp } from '../../../test/render-app';
import { formatAzn } from './money';

const PLUMBING = '11111111-1111-4111-8111-111111111111';
const LOCKS = '22222222-2222-4222-8222-222222222222';
const ELECTRIC = '33333333-3333-4333-8333-333333333333';
const LEAK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOILER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const CATALOGUE: AdminCatalogue = {
  categories: [
    // Deliberately out of order: the editor sorts by displayOrder.
    {
      id: ELECTRIC,
      slug: 'electric',
      name: { az: 'Elektrik' },
      displayOrder: 2,
      isActive: true,
      services: [],
    },
    {
      id: PLUMBING,
      slug: 'plumbing',
      name: { az: 'Santexnika', en: 'Plumbing' },
      displayOrder: 0,
      isActive: true,
      services: [
        {
          id: LEAK,
          categoryId: PLUMBING,
          slug: 'leak-repair',
          name: { az: 'Sızma təmiri' },
          pricingKind: 'fixed',
          basePriceMinor: 4550,
          displayOrder: 0,
          isActive: true,
        },
        {
          id: BOILER,
          categoryId: PLUMBING,
          slug: 'boiler-check',
          name: { az: 'Kombi yoxlanışı' },
          pricingKind: 'inspection',
          basePriceMinor: null,
          displayOrder: 1,
          isActive: false,
        },
      ],
    },
    {
      id: LOCKS,
      slug: 'locks',
      name: { az: 'Qıfıllar' },
      displayOrder: 1,
      isActive: false,
      services: [],
    },
  ],
};

function catalogueServer() {
  return installFakeServer()
    .on('GET', '/api/admin/me', { status: 200, body: adminMe() })
    .on('GET', '/api/admin/catalogue', { status: 200, body: CATALOGUE });
}

async function openCatalogue(server = catalogueServer()) {
  const rendered = renderApp('/catalogue');
  await screen.findByRole('region', { name: 'Santexnika' });
  return { server, ...rendered };
}

describe('catalogue editor', () => {
  it('lists categories in display order with their services, inactive ones marked', async () => {
    await openCatalogue();

    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(['Santexnika', 'Qıfıllar', 'Elektrik']);

    const plumbing = screen.getByRole('region', { name: 'Santexnika' });
    const rows = within(plumbing).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('Sızma təmiri');
    // Raw textContent: the matcher would collapse ICU's no-break space, the helper does not.
    expect(rows[0]?.textContent).toContain(formatAzn(4550));
    expect(rows[0]).toHaveTextContent('Active');
    expect(rows[1]).toHaveTextContent('Kombi yoxlanışı');
    expect(rows[1]).toHaveTextContent('Inspection');
    expect(rows[1]).toHaveTextContent('Inactive');

    const locks = screen.getByRole('region', { name: 'Qıfıllar' });
    expect(within(locks).getByText('Inactive')).toBeInTheDocument();
    expect(within(locks).getByRole('button', { name: 'Activate' })).toBeInTheDocument();
  });

  it('creates a fixed-price service with the price converted to qəpik exactly', async () => {
    const { server, user } = await openCatalogue(
      catalogueServer().on('POST', '/api/admin/catalogue/services', { status: 201, body: {} }),
    );

    const plumbing = screen.getByRole('region', { name: 'Santexnika' });
    await user.click(within(plumbing).getByRole('button', { name: 'Add service' }));
    const dialog = screen.getByRole('dialog', { name: 'New service' });
    await user.type(within(dialog).getByLabelText('Slug'), 'tap-replacement');
    await user.type(within(dialog).getByLabelText('Name (Azerbaijani)'), 'Kran dəyişmə');
    await user.type(within(dialog).getByLabelText('Name (English, optional)'), 'Tap replacement');
    await user.type(within(dialog).getByLabelText('Reference price (AZN)'), '4.35');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(server.calls('POST', '/api/admin/catalogue/services')[0]?.body).toEqual({
      categoryId: PLUMBING,
      slug: 'tap-replacement',
      name: { az: 'Kran dəyişmə', en: 'Tap replacement' },
      pricingKind: 'fixed',
      basePriceMinor: 435,
      isActive: true,
    });
    // The write invalidated the catalogue, so the editor re-read it.
    await waitFor(() => {
      expect(server.calls('GET', '/api/admin/catalogue')).toHaveLength(2);
    });
  });

  it('switches the price off for an inspection service and sends none', async () => {
    const { server, user } = await openCatalogue(
      catalogueServer().on('POST', '/api/admin/catalogue/services', { status: 201, body: {} }),
    );

    const plumbing = screen.getByRole('region', { name: 'Santexnika' });
    await user.click(within(plumbing).getByRole('button', { name: 'Add service' }));
    const dialog = screen.getByRole('dialog', { name: 'New service' });
    await user.type(within(dialog).getByLabelText('Reference price (AZN)'), '20');
    await user.selectOptions(within(dialog).getByLabelText('Pricing'), 'inspection');

    const price = within(dialog).getByLabelText('Reference price (AZN)');
    expect(price).toBeDisabled();
    expect(price).toHaveAccessibleDescription(
      'An inspection-priced service has no reference price.',
    );

    await user.type(within(dialog).getByLabelText('Slug'), 'drain-check');
    await user.type(within(dialog).getByLabelText('Name (Azerbaijani)'), 'Kanalizasiya yoxlanışı');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(server.calls('POST', '/api/admin/catalogue/services')).toHaveLength(1);
    });
    const body = server.calls('POST', '/api/admin/catalogue/services')[0]?.body;
    expect(body).toMatchObject({ pricingKind: 'inspection' });
    expect(body).not.toHaveProperty('basePriceMinor');
  });

  it('refuses a fixed-price service without a price, and a malformed one, before calling the API', async () => {
    const { server, user } = await openCatalogue();

    const plumbing = screen.getByRole('region', { name: 'Santexnika' });
    await user.click(within(plumbing).getByRole('button', { name: 'Add service' }));
    const dialog = screen.getByRole('dialog', { name: 'New service' });
    await user.type(within(dialog).getByLabelText('Slug'), 'Bad Slug');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(within(dialog).getByLabelText('Reference price (AZN)')).toHaveAccessibleDescription(
      'A fixed-price service needs a reference price.',
    );
    expect(within(dialog).getByLabelText('Name (Azerbaijani)')).toHaveAccessibleDescription(
      'An Azerbaijani name is required.',
    );
    expect(within(dialog).getByLabelText('Slug')).toBeInvalid();

    await user.type(within(dialog).getByLabelText('Reference price (AZN)'), '4.355');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getByLabelText('Reference price (AZN)')).toHaveAccessibleDescription(
      'Enter an amount like 45 or 45.50.',
    );

    expect(server.calls('POST', '/api/admin/catalogue/services')).toHaveLength(0);
  });

  it('edits a category by sending only what changed', async () => {
    const { server, user } = await openCatalogue(
      catalogueServer().on('PATCH', `/api/admin/catalogue/categories/${LOCKS}`, {
        status: 200,
        body: {},
      }),
    );

    const locks = screen.getByRole('region', { name: 'Qıfıllar' });
    await user.click(within(locks).getByRole('button', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit category' });
    expect(within(dialog).getByLabelText('Slug')).toHaveValue('locks');
    await user.type(within(dialog).getByLabelText('Name (Russian, optional)'), 'Замки');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(server.calls('PATCH', `/api/admin/catalogue/categories/${LOCKS}`)[0]?.body).toEqual({
      name: { az: 'Qıfıllar', ru: 'Замки' },
    });
  });

  it('edits a service price and sends the kind with it', async () => {
    const { server, user } = await openCatalogue(
      catalogueServer().on('PATCH', `/api/admin/catalogue/services/${LEAK}`, {
        status: 200,
        body: {},
      }),
    );

    await user.click(screen.getByRole('button', { name: 'Edit Sızma təmiri' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit service' });
    const price = within(dialog).getByLabelText('Reference price (AZN)');
    expect(price).toHaveValue('45.50');
    await user.clear(price);
    await user.type(price, '19,99');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(server.calls('PATCH', `/api/admin/catalogue/services/${LEAK}`)).toHaveLength(1);
    });
    expect(server.calls('PATCH', `/api/admin/catalogue/services/${LEAK}`)[0]?.body).toEqual({
      pricingKind: 'fixed',
      basePriceMinor: 1999,
    });
  });

  it('shows the slug-taken refusal on the slug field and keeps the form open', async () => {
    const { user } = await openCatalogue(
      catalogueServer().on(
        'POST',
        '/api/admin/catalogue/categories',
        apiError(409, 'CATALOGUE_SLUG_TAKEN'),
      ),
    );

    await user.click(screen.getByRole('button', { name: 'New category' }));
    const dialog = screen.getByRole('dialog', { name: 'New category' });
    await user.type(within(dialog).getByLabelText('Slug'), 'plumbing');
    await user.type(within(dialog).getByLabelText('Name (Azerbaijani)'), 'Santexnika 2');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(within(dialog).getByLabelText('Slug')).toHaveAccessibleDescription(
        'This slug is already used by another category or service. Choose another.',
      );
    });
    expect(within(dialog).getByLabelText('Name (Azerbaijani)')).toHaveValue('Santexnika 2');
  });

  it('puts a 422 from the server on the field it names', async () => {
    const { user } = await openCatalogue(
      catalogueServer().on('POST', '/api/admin/catalogue/categories', {
        status: 422,
        body: {
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Validation failed.',
            requestId: 'test',
            details: { issues: [{ path: 'displayOrder', message: 'Too big' }] },
          },
        },
      }),
    );

    await user.click(screen.getByRole('button', { name: 'New category' }));
    const dialog = screen.getByRole('dialog', { name: 'New category' });
    await user.type(within(dialog).getByLabelText('Slug'), 'garden');
    await user.type(within(dialog).getByLabelText('Name (Azerbaijani)'), 'Bağ');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(within(dialog).getByLabelText('Display order (optional)')).toBeInvalid();
    });
    expect(within(dialog).getByLabelText('Display order (optional)')).toHaveAccessibleDescription(
      'A whole number from 0 to 1,000,000.',
    );
  });

  it('reorders categories by sending the whole new permutation', async () => {
    const { server, user } = await openCatalogue(
      catalogueServer().on('PUT', '/api/admin/catalogue/categories/order', {
        status: 200,
        body: CATALOGUE,
      }),
    );

    expect(screen.getByRole('button', { name: 'Move Santexnika up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Elektrik down' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Move Elektrik up' }));

    await waitFor(() => {
      expect(server.calls('PUT', '/api/admin/catalogue/categories/order')).toHaveLength(1);
    });
    expect(server.calls('PUT', '/api/admin/catalogue/categories/order')[0]?.body).toEqual({
      ids: [PLUMBING, ELECTRIC, LOCKS],
    });
  });

  it('reorders the services inside one category', async () => {
    const path = `/api/admin/catalogue/categories/${PLUMBING}/services/order`;
    const { server, user } = await openCatalogue(
      catalogueServer().on('PUT', path, { status: 200, body: CATALOGUE }),
    );

    await user.click(screen.getByRole('button', { name: 'Move Sızma təmiri down' }));

    await waitFor(() => {
      expect(server.calls('PUT', path)).toHaveLength(1);
    });
    expect(server.calls('PUT', path)[0]?.body).toEqual({ ids: [BOILER, LEAK] });
  });

  it('deactivates and activates with a one-field patch', async () => {
    const { server, user } = await openCatalogue(
      catalogueServer()
        .on('PATCH', `/api/admin/catalogue/services/${LEAK}`, { status: 200, body: {} })
        .on('PATCH', `/api/admin/catalogue/categories/${LOCKS}`, { status: 200, body: {} }),
    );

    await user.click(screen.getByRole('button', { name: 'Deactivate Sızma təmiri' }));
    const locks = screen.getByRole('region', { name: 'Qıfıllar' });
    await user.click(within(locks).getByRole('button', { name: 'Activate' }));

    await waitFor(() => {
      expect(server.calls('PATCH', `/api/admin/catalogue/categories/${LOCKS}`)).toHaveLength(1);
    });
    expect(server.calls('PATCH', `/api/admin/catalogue/services/${LEAK}`)[0]?.body).toEqual({
      isActive: false,
    });
    expect(server.calls('PATCH', `/api/admin/catalogue/categories/${LOCKS}`)[0]?.body).toEqual({
      isActive: true,
    });
  });

  it('says so when a toggle is refused', async () => {
    const { user } = await openCatalogue(
      catalogueServer().on(
        'PATCH',
        `/api/admin/catalogue/services/${LEAK}`,
        apiError(500, 'INTERNAL_ERROR'),
      ),
    );

    await user.click(screen.getByRole('button', { name: 'Deactivate Sızma təmiri' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That change was not saved. Try again.',
    );
  });
});
