import type { MasterDocumentType } from '@tezusta/types';

import type { DocumentSlot } from './onboarding-state';

/**
 * Azerbaijani copy for becoming a master (#490). Placeholder wording, like the
 * rest of the app's copy, until the owner's copy pass.
 */
export const MASTER_ONBOARDING_COPY = {
  // The choice a brand-new account sees before anything else.
  choiceTitle: 'TezUsta-dan necə istifadə edəcəksiniz?',
  choiceCustomer: 'Sifariş vermək istəyirəm',
  choiceCustomerHint: 'Evinizə usta çağırın.',
  choiceMaster: 'Usta kimi işləmək istəyirəm',
  choiceMasterHint: 'Yaxınlıqdakı sifarişləri qəbul edin.',

  // The Settings entry for an existing customer.
  settingsEntry: 'Usta ol',

  // Step 1: the profile.
  profileTitle: 'Usta profili',
  profileDescription: 'Müştərilər sifarişi qəbul etdiyiniz zaman bu adı görəcək.',
  nameField: 'Ad',
  namePlaceholder: 'Məsələn, Elvin',
  bioField: 'Özünüz haqqında (istəyə bağlı)',
  bioPlaceholder: 'Təcrübəniz, hansı işləri gördüyünüz',
  profileAction: 'Davam et',
  profileError: 'Profil yaradılmadı. Bir az sonra yenidən cəhd edin.',

  // Step 2: the documents.
  documentsTitle: 'Şəxsiyyətinizi təsdiqləyin',
  documentsDescription:
    'Üç şəkil lazımdır. Onları yalnız TezUsta-nın yoxlama komandası görür və heç vaxt müştərilərə göstərilmir.',
  documentsChangesRequested:
    'Bəzi sənədlərinizi yeniləmək lazımdır. Qırmızı ilə qeyd olunanları dəyişib yenidən göndərin.',
  documentLabels: {
    id_card_front: 'Şəxsiyyət vəsiqəsinin ön tərəfi',
    id_card_back: 'Şəxsiyyət vəsiqəsinin arxa tərəfi',
    selfie_with_id: 'Vəsiqəni əlinizdə tutduğunuz selfi',
  } satisfies Record<MasterDocumentType, string>,
  slotLabels: {
    missing: 'Əlavə edilməyib',
    in_review: 'Göndərilib',
    accepted: 'Təsdiqlənib',
    rejected: 'Yenidən göndərin',
  } satisfies Record<DocumentSlot, string>,
  pickPhoto: 'Şəkil seç',
  replacePhoto: 'Dəyiş',
  retryUpload: 'Yenidən göndər',
  uploading: 'Göndərilir…',
  uploadFailed: 'Şəkil göndərilmədi.',
  libraryDenied: 'Şəkil seçmək üçün qalereyaya icazə verin.',
  cameraHint: 'Şəkli telefonun kamerası ilə çəkib buradan seçə bilərsiniz.',
  submitAction: 'Yoxlamaya göndər',
  submitError: 'Göndərilmədi. Bir az sonra yenidən cəhd edin.',

  // Step 3: waiting, and the ends.
  inReviewTitle: 'Sənədləriniz yoxlanılır',
  inReviewDescription:
    'Yoxlama bitəndə xəbər verəcəyik. Bu arada xidmətlərinizi və qiymətlərinizi əlavə edə bilərsiniz.',
  activeTitle: 'Siz artıq ustasınız',
  activeDescription: 'Profiliniz təsdiqlənib.',
  closedTitle: 'Profiliniz təsdiqlənmədi',
  closedDescription: 'Ətraflı məlumat üçün dəstək xidməti ilə əlaqə saxlayın.',
  goToMaster: 'Usta səhifəsinə keç',

  // The master home's notice while verification is unfinished.
  noticePending: 'Profiliniz yoxlanılır. Sənədlərinizə buradan baxa və onları dəyişə bilərsiniz.',
  noticeChangesRequested: 'Sənədlərinizdə çatışmazlıq var. Onları yeniləyib yenidən göndərin.',
  noticeAction: 'Sənədlər',

  back: 'Geri',
  loading: 'Yüklənir',
  loadError: 'Məlumat yüklənmədi.',
  retry: 'Yenidən cəhd et',
} as const;
